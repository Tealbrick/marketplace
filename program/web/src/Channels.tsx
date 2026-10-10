import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Bot, CheckCircle2, ExternalLink, LoaderCircle, Megaphone, Pause, Pencil, Play, Plus, Send, ShieldCheck, X } from "lucide-react";
import { Button, Tag } from "@tealbrick/ui";

import { getAgentGrants, requestAgentGrant } from "./agent-grants-api";
import { ConfirmDialog, type ConfirmState } from "./Catalog";
import { getChannels, newChannelKey, sendChannelTest, setChannelStatus, type ChannelSendAnswer } from "./channels-api";
import { capabilityRows, CHANNEL_PROVIDERS, formatSeconds, PROVIDER_LABEL, providerLabel, safeHttpsUrl, typeName, WEEKDAYS } from "./channels-model";
import { CreateChannelPanel, DestinationTitle, EditChannelPanel } from "./ChannelForms";
import { GrantInbox } from "./ChannelGrants";
import { ReceiptsSection, ReceiptSummary, UncertainPosts, WaitingPosts } from "./ChannelPosts";
import { ApprovalsPanel } from "./CompanyBox";
import { CHANNEL_TOKEN_HINT, SLACK_SETUP_STEPS, TEAMS_SETUP_STEPS } from "./copy";
import type { AgentGrantRequestResponse, ChannelProviderEntry, ChannelProviderId, ChannelReadiness, ChannelsBrowseAnswer, ChannelStatus, ChannelView } from "./types";
import { formatWhen, InlineError, StatePanel } from "./ui";

export const CHANNELS_QUERY_KEY = ["channels"] as const;

const READINESS_COPY: Record<ChannelReadiness, { label: string; tone: "success" | "warning" | "danger" | "default"; detail: string; dot: string }> = {
  available: { label: "Available", tone: "success", detail: "The bot token is verified. You can discover destinations and add channels.", dot: "healthy" },
  credential_missing: { label: "Credential missing", tone: "warning", detail: CHANNEL_TOKEN_HINT, dot: "degraded" },
  credential_invalid: { label: "Credential invalid", tone: "danger", detail: "The provider didn't accept the bot token. Replace it under Account Connections in Teal Brick Portal. Marketplace never asks for the token here.", dot: "missing" },
  paused: { label: "Paused", tone: "default", detail: "Sending through this provider is paused.", dot: "unknown" },
  unavailable: { label: "Unavailable", tone: "danger", detail: "Marketplace couldn't reach the provider to verify the bot. It retries at start-up.", dot: "missing" },
};

const STATUS_TONE: Record<ChannelStatus, "success" | "warning" | "default" | "accent"> = { active: "success", paused: "warning", draft: "accent", archived: "default" };
const STATUS_LABEL: Record<ChannelStatus, string> = { active: "Active", paused: "Paused", draft: "Draft", archived: "Archived" };

/** Readiness per provider; in inert mode (no credentials configured) only these cards are shown. */
function ProviderReadiness({ browse }: { browse: ChannelsBrowseAnswer }) {
  const entries = new Map(browse.providers.map((entry) => [entry.id, entry]));
  return <div className="provider-grid channel-providers" aria-label="Channel providers">
    {CHANNEL_PROVIDERS.filter((provider) => entries.has(provider) || (browse.configured && browse.readiness[provider] !== undefined)).map((provider) => {
      const readiness = entries.get(provider)?.readiness ?? (browse.configured ? browse.readiness[provider] : undefined) ?? "unavailable";
      const copy = READINESS_COPY[readiness] ?? READINESS_COPY.unavailable;
      const connection = browse.configured ? browse.connections[provider] ?? null : null;
      const channels = browse.configured ? browse.channels.filter((channel) => channel.provider === provider && channel.status !== "archived").length : 0;
      return <article key={provider} aria-label={`${PROVIDER_LABEL[provider]} readiness`}>
        <div><span className={`provider-dot provider-dot--${copy.dot}`} aria-hidden="true" /><h2>{PROVIDER_LABEL[provider]}</h2><Tag tone={copy.tone}>{copy.label}</Tag></div>
        <p>{copy.detail}</p>
        <dl>
          <dt>Bot</dt><dd>{connection?.botUsername ? <code>@{connection.botUsername}</code> : "—"}</dd>
          <dt>Verified</dt><dd>{formatWhen(connection?.verifiedAt)}</dd>
          <dt>Channels</dt><dd>{channels}</dd>
        </dl>
        {provider === "slack" && readiness !== "available" && <details className="provider-setup">
          <summary>Set up the Slack app</summary>
          <ol>{SLACK_SETUP_STEPS.map((step) => <li key={step}>{step}</li>)}</ol>
        </details>}
        {provider === "teams" && readiness !== "available" && <details className="provider-setup">
          <summary>Set up the Microsoft Teams bot</summary>
          <ol>{TEAMS_SETUP_STEPS.map((step) => <li key={step}>{step}</li>)}</ol>
        </details>}
      </article>;
    })}
  </div>;
}

function CapabilitiesList({ channel }: { channel: ChannelView }) {
  if (!channel.capabilities) return <p className="muted-detail">This provider isn't loaded, so its capabilities are unknown.</p>;
  return <dl className="capability-list" aria-label="What agents can send">
    {capabilityRows(channel.capabilities).map((row) => <div key={row.key} className={row.available ? "" : "is-unavailable"}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
  </dl>;
}

function PolicySummary({ channel }: { channel: ChannelView }) {
  const { policy } = channel;
  const files = policy.content.files;
  const window = policy.schedule.window;
  return <dl className="fact-list">
    <dt>Posts per day</dt><dd>{policy.caps.perDay} (used {channel.usageToday} in the last 24 h)</dd>
    <dt>Posts per hour</dt><dd>{policy.caps.perHour ?? "No hourly limit"}</dd>
    <dt>Minimum gap</dt><dd>{formatSeconds(policy.caps.minIntervalSeconds)}</dd>
    <dt>One per phase</dt><dd>{policy.caps.onePerPhase ? "Yes" : "No"}</dd>
    <dt>Standing grants</dt><dd>{policy.standingGrants === "allowed" ? "Allowed (you approve each one)" : "Off (every post waits for approval)"}</dd>
    <dt>Files</dt><dd>{files.allowed ? `${files.types.map(typeName).join(", ") || "No types"} · ${files.maxCount} per post` : "Not allowed"}</dd>
    <dt>Blocked words</dt><dd>{policy.content.denyPatterns.length ? policy.content.denyPatterns.length : "None"}</dd>
    <dt>Confirmed events</dt><dd>{policy.content.requireConfirmedEvent ? `Required on ${policy.content.listingHosts.join(", ")}` : "Not required"}</dd>
    <dt>Window</dt><dd>{window ? `${window.start}–${window.end} ${window.timeZone}${window.days ? ` · ${window.days.map((day) => WEEKDAYS[day]).join(", ")}` : ""}` : "Any time"}</dd>
  </dl>;
}

function newRequestKey() {
  return newChannelKey("channel-grant");
}

/**
 * "Grant to agent": the existing consent request with the channel's class
 * selection (actionGroup `channel:<slug>`, actionGroupLabel = channel label).
 * Portal shows its consent dialog; nothing is granted until it is approved there.
 */
function GrantToAgent({ channel, workspaceSlug, onClose }: { channel: ChannelView; workspaceSlug: string; onClose: () => void }) {
  const id = useId();
  const queryClient = useQueryClient();
  const grants = useQuery({ queryKey: ["agent-grants", workspaceSlug], queryFn: () => getAgentGrants(workspaceSlug), enabled: Boolean(workspaceSlug), retry: false });
  const known = [...new Set([...(grants.data?.consents ?? []).map((consent) => consent.agentId), ...(grants.data?.handoffRequests ?? []).map((request) => request.agentId)])];
  const seedDeployment = grants.data?.handoffRequests?.[0]?.deploymentId ?? grants.data?.consents?.[0]?.deploymentId ?? "";
  const [agentId, setAgentId] = useState("");
  const [deploymentId, setDeploymentId] = useState("");
  const [key, setKey] = useState(newRequestKey);
  const [result, setResult] = useState<AgentGrantRequestResponse | null>(null);
  useEffect(() => { if (!deploymentId && seedDeployment) setDeploymentId(seedDeployment); }, [seedDeployment]);
  useEffect(() => { if (!agentId && known.length === 1) setAgentId(known[0]!); }, [known.length]);
  const request = useMutation({
    mutationFn: () => requestAgentGrant({ deploymentId: deploymentId.trim(), agentId: agentId.trim(), selection: channel.grantSelection, idempotencyKey: key }),
    onSuccess: (response) => { setResult(response); setKey(newRequestKey()); void queryClient.invalidateQueries({ queryKey: ["agent-grants", workspaceSlug] }); },
  });
  const reviewUrl = result ? safeHttpsUrl(result.request.approvalUrl) ?? result.request.approvalUrl : null;
  return <section className="grant-to-agent" aria-labelledby={`${id}-title`}>
    <div className="section-heading"><div><p className="eyebrow">Portal consent</p><h4 id={`${id}-title`}>Grant {channel.label} to an agent</h4></div><Button size="small" onClick={onClose} aria-label="Close grant to agent"><X size={14} /></Button></div>
    <p className="muted-detail">The agent may then post to this channel only. Each post still needs your approval, unless you approve a standing grant later.</p>
    <form onSubmit={(event) => { event.preventDefault(); request.mutate(); }}>
      <div className="form-grid two">
        <label>Agent<input list={`${id}-agents`} value={agentId} onChange={(event) => setAgentId(event.target.value)} placeholder="Portal-attested agent" required />{known.length > 0 && <datalist id={`${id}-agents`}>{known.map((agent) => <option key={agent} value={agent} />)}</datalist>}</label>
        <label>Access<input value="Outward: post and schedule" readOnly /></label>
      </div>
      <details className="technical-details">
        <summary>Developer details</summary>
        <div className="form-grid two"><label>Portal deployment ID<input value={deploymentId} onChange={(event) => setDeploymentId(event.target.value)} placeholder="From the Portal launch context" required /></label></div>
        <dl className="contract-list"><dt>Action group</dt><dd><code>{channel.grantSelection.actionGroup}</code></dd><dt>Plugin</dt><dd><code>{channel.grantSelection.pluginId}</code></dd><dt>Class</dt><dd><code>{channel.grantSelection.grantClass}</code></dd></dl>
      </details>
      {!deploymentId.trim() && <p className="muted-detail">Start from the agent's connection in Teal Brick Portal; Portal fills in the deployment for you.</p>}
      {request.error && <InlineError error={request.error} />}
      <div className="dialog-actions"><Button size="small" tone="primary" type="submit" disabled={request.isPending || !agentId.trim() || !deploymentId.trim()}>{request.isPending ? <LoaderCircle className="spin" size={14} /> : <ShieldCheck size={14} />}Request approval in Portal</Button></div>
    </form>
    {result && reviewUrl && <div className="request-result contract-gap" role="status"><ShieldCheck size={18} /><div><strong>Approval requested</strong><p>Open the request in Teal Brick Portal and approve it, then reconcile it under Agent grants.</p><a href={reviewUrl} target="_blank" rel="noopener noreferrer">Open Portal review <ExternalLink size={13} /></a></div></div>}
  </section>;
}

function ChannelDetail({ channel, providers, workspaceSlug, onConfirm, onNotice, onChanged }: { channel: ChannelView; providers: ChannelProviderEntry[]; workspaceSlug: string; onConfirm: (state: NonNullable<ConfirmState> & { after?: (result: unknown) => void }) => void; onNotice: (notice: string) => void; onChanged: () => void }) {
  const [mode, setMode] = useState<"view" | "edit" | "grant">("view");
  const [testAnswer, setTestAnswer] = useState<ChannelSendAnswer | null>(null);
  useEffect(() => { setMode("view"); setTestAnswer(null); }, [channel.id]);
  const status = useMutation({
    mutationFn: (verb: "pause" | "resume") => setChannelStatus(channel.id, verb),
    onSuccess: (result, verb) => {
      const suspended = result.suspendedGrants?.length ?? 0;
      onNotice(verb === "pause" ? `Paused ${channel.label}.${suspended ? ` ${suspended} standing ${suspended === 1 ? "grant was" : "grants were"} suspended.` : ""}` : `Resumed ${channel.label}. Suspended grants need your approval again.`);
      onChanged();
    },
  });
  const archived = channel.status === "archived";
  const destinationUrl = safeHttpsUrl(channel.destination.url);
  const confirmTest = () => onConfirm({
    title: `Send a test message to ${channel.destination.title || channel.label}?`,
    detail: `Marketplace posts a fixed test text to ${providerLabel(channel.provider)} ${channel.destination.type} “${channel.destination.title}” now. It counts toward this channel's limits.`,
    label: "Send test message",
    run: () => sendChannelTest(channel.id, newChannelKey("channel-test")),
    after: (result) => { setTestAnswer(result as ChannelSendAnswer); onChanged(); },
  });
  const confirmArchive = () => onConfirm({
    title: `Archive ${channel.label}?`,
    detail: "Agents can no longer post here, every standing grant is suspended, and the channel can't be restored. Receipts stay.",
    label: "Archive channel",
    danger: true,
    run: () => setChannelStatus(channel.id, "archive"),
    after: () => { onNotice(`Archived ${channel.label}.`); onChanged(); },
  });
  return <article className="channel-detail" aria-labelledby={`channel-${channel.id}-title`}>
    <header className="channel-detail__header">
      <div>
        <p className="eyebrow">{providerLabel(channel.provider)} · {channel.kind} · revision {channel.revision}</p>
        <h3 id={`channel-${channel.id}-title`}>{channel.label}</h3>
        <p className="muted-detail"><DestinationTitle destination={channel.destination} /> · {channel.destination.type} · <code>channel:{channel.slug}</code>{destinationUrl && <> · <a href={destinationUrl} target="_blank" rel="noopener noreferrer">Open<span className="visually-hidden"> destination (opens in a new tab)</span></a></>}</p>
      </div>
      <Tag tone={STATUS_TONE[channel.status]}>{STATUS_LABEL[channel.status]}</Tag>
    </header>
    {!archived && <div className="dialog-actions channel-actions">
      {channel.status === "active" || channel.status === "draft"
        ? <Button size="small" disabled={status.isPending} onClick={() => status.mutate("pause")}>{status.isPending ? <LoaderCircle className="spin" size={14} /> : <Pause size={14} />}Pause</Button>
        : <Button size="small" disabled={status.isPending} onClick={() => status.mutate("resume")}>{status.isPending ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}Resume</Button>}
      <Button size="small" onClick={() => setMode(mode === "edit" ? "view" : "edit")} aria-pressed={mode === "edit"}><Pencil size={14} />Edit rules</Button>
      <Button size="small" disabled={channel.status !== "active"} title={channel.status !== "active" ? "Resume the channel first" : undefined} onClick={confirmTest}><Send size={14} />Send test message</Button>
      <Button size="small" tone="primary" disabled={channel.status !== "active"} onClick={() => setMode(mode === "grant" ? "view" : "grant")} aria-pressed={mode === "grant"}><Bot size={14} />Grant to agent</Button>
      <Button size="small" tone="danger" onClick={confirmArchive}><Archive size={14} />Archive</Button>
    </div>}
    {status.error && <InlineError error={status.error} />}
    {testAnswer && <div className="test-result" role="status">
      <strong>{testAnswer.receipt?.status === "sent" ? <><CheckCircle2 size={14} aria-hidden="true" /> Test message sent</> : "Test message not confirmed"}</strong>
      {testAnswer.receipt && <ReceiptSummary receipt={testAnswer.receipt} channel={channel} />}
    </div>}
    {mode === "edit" && <EditChannelPanel channel={channel} providers={providers} onCancel={() => setMode("view")} onSaved={(_saved, suspended) => { setMode("view"); onNotice(`Saved the rules for ${channel.label}.${suspended.length ? ` ${suspended.length} standing ${suspended.length === 1 ? "grant was" : "grants were"} suspended because ${suspended.length === 1 ? "it is" : "they are"} above the new ceiling.` : ""}`); onChanged(); }} />}
    {mode === "grant" && <GrantToAgent channel={channel} workspaceSlug={workspaceSlug} onClose={() => setMode("view")} />}
    <div className="channel-detail__grid">
      <section aria-label="About this channel">
        <h4>About</h4>
        <dl className="fact-list">
          <dt>Audience</dt><dd>{channel.audience || "—"}</dd>
          <dt>Purpose</dt><dd>{channel.purpose || "—"}</dd>
          <dt>Language</dt><dd>{channel.language || "—"}</dd>
          <dt>Updated</dt><dd>{formatWhen(channel.updatedAt)}</dd>
        </dl>
        <h4>Posting rules</h4>
        <PolicySummary channel={channel} />
      </section>
      <section aria-label="What agents can send">
        <h4>What agents can send</h4>
        <CapabilitiesList channel={channel} />
      </section>
    </div>
  </article>;
}

export function ChannelsPage({ workspaceSlug }: { workspaceSlug: string }) {
  const queryClient = useQueryClient();
  const browse = useQuery({ queryKey: CHANNELS_QUERY_KEY, queryFn: getChannels, retry: false, refetchInterval: 30_000 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<(NonNullable<ConfirmState> & { after?: (result: unknown) => void }) | null>(null);
  const changed = () => {
    void queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ["channel-receipts"] });
    void queryClient.invalidateQueries({ queryKey: ["channel-posts"] });
    void queryClient.invalidateQueries({ queryKey: ["company-box-approvals"] });
  };
  const announce = (message: string) => { setNotice(message); changed(); };
  const channels = browse.data?.configured ? browse.data.channels : [];
  const visible = channels.filter((channel) => channel.status !== "archived");
  const archivedChannels = channels.filter((channel) => channel.status === "archived");
  const selected = channels.find((channel) => channel.id === selectedId) ?? visible[0] ?? null;

  if (browse.isLoading) return <section className="collection-page"><div className="collection-empty"><LoaderCircle className="spin" size={28} /><h2>Loading channels</h2><p>Checking providers and destinations.</p></div></section>;
  if (browse.error || !browse.data) return <section className="collection-page">{browse.error ? <StatePanel error={browse.error} onRetry={() => void browse.refetch()} /> : null}</section>;
  if (!browse.data.configured) {
    // Inert mode: no channel credentials yet. Only readiness and where to add a bot token.
    return <section className="collection-page channels-page">
      <header><div><p className="eyebrow">Outward destinations</p><h1>Channels</h1><p>Chats and channels your agents may post to, with the limits you set.</p></div></header>
      <div className="credential-proof channel-inert" role="status"><ShieldCheck size={18} /><div><strong>Channels aren't set up yet</strong><p>{CHANNEL_TOKEN_HINT} After the token is saved and Marketplace restarts, you can discover destinations and add channels here.</p></div></div>
      <ProviderReadiness browse={browse.data} />
    </section>;
  }
  const data = browse.data;
  const anyReady = CHANNEL_PROVIDERS.some((provider: ChannelProviderId) => data.readiness[provider] === "available");

  return <section className="collection-page channels-page">
    <header>
      <div><p className="eyebrow">Outward destinations</p><h1>Channels</h1><p>Chats and channels your agents may post to, with the limits you set. Every post needs your approval or a standing grant you approved, and every send leaves a receipt.</p></div>
      <Tag>{visible.length} {visible.length === 1 ? "channel" : "channels"}</Tag>
    </header>
    {notice && <p className="inline-success channel-notice" role="status"><CheckCircle2 size={14} />{notice}<button type="button" aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={13} /></button></p>}
    <ProviderReadiness browse={data} />
    <div className="channel-approvals"><ApprovalsPanel onNotice={announce} only="channel" /></div>
    <UncertainPosts posts={data.uncertainPosts} channels={channels} onNotice={announce} />
    <WaitingPosts channels={channels} onConfirm={setConfirm} onNotice={announce} />
    <GrantInbox channels={channels} onNotice={announce} />
    <section className="channel-section" aria-labelledby="channel-list-heading">
      <div className="section-heading"><div><p className="eyebrow">Destinations</p><h2 id="channel-list-heading">Your channels</h2></div>{!creating && <Button size="small" tone="primary" disabled={!anyReady} title={anyReady ? undefined : "Add a bot token in Teal Brick Portal first"} onClick={() => setCreating(true)}><Plus size={14} />Add channel</Button>}</div>
      {creating && <CreateChannelPanel browse={data} onCancel={() => setCreating(false)} onCreated={(channel) => { setCreating(false); setSelectedId(channel.id); announce(`Created ${channel.label}.`); }} />}
      {visible.length || archivedChannels.length ? <div className="channels-layout">
        <nav className="channel-index" aria-label="Channels">
          {[...visible, ...archivedChannels].map((channel) => <button type="button" key={channel.id} className="channel-index__item" aria-current={selected?.id === channel.id ? "true" : undefined} onClick={() => setSelectedId(channel.id)}>
            <span><strong>{channel.label}</strong><small><DestinationTitle destination={channel.destination} /></small></span>
            <span className="channel-index__meta"><Tag tone={STATUS_TONE[channel.status]}>{STATUS_LABEL[channel.status]}</Tag><small>{providerLabel(channel.provider)}</small></span>
          </button>)}
        </nav>
        {selected && <ChannelDetail channel={selected} providers={data.providers} workspaceSlug={workspaceSlug} onConfirm={setConfirm} onNotice={announce} onChanged={changed} />}
      </div> : !creating && <div className="collection-empty compact"><Megaphone /><h3>No channels yet</h3><p>{anyReady ? "Add a Telegram chat, a Discord or Slack channel, or a Microsoft Teams channel or chat your agents may post to." : CHANNEL_TOKEN_HINT}</p></div>}
    </section>
    <ReceiptsSection channels={channels} onConfirm={(state) => setConfirm(state)} onNotice={announce} />
    <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} onSuccess={(result) => confirm?.after?.(result)} />
  </section>;
}
