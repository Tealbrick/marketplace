import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, Boxes, Check, CircleSlash, Hourglass, KeyRound, LoaderCircle, PlugZap, Send, Settings2, Trash2, Undo2, X } from "lucide-react";
import { Button, IconButton, Tag } from "@tealbrick/ui";

import { ApiError, decideCompanyBoxApproval, getCompanyBox, getCompanyBoxApproval, getCompanyBoxApprovals, removeCompanyBoxEntry, setupCompanyBoxEntry, testCompanyBoxEntry } from "./api";
import { getChannels } from "./channels-api";
import { actionTitle, digestPrefix, formatBytes, providerLabel, transcriptsFromCanonical, typeName } from "./channels-model";
import { BUZZ_CODE_CHARS, BUZZ_CODE_HINT, errorCopy } from "./copy";
import type { ChannelActionView, ChannelApprovalSummary, ChannelPayloadView, CompanyBoxApproval, CompanyBoxCredentialKey, CompanyBoxEntry, CompanyBoxResult } from "./types";
import { formatWhen, InlineError, StatePanel, statusLabel, statusTone } from "./ui";

const SOURCE_LABEL: Record<CompanyBoxEntry["source"], string> = { openapi: "REST API", mcp: "MCP server" };

export function coverageLabel(entry: Pick<CompanyBoxEntry, "coverage">) {
  return `${entry.coverage.exposed}/${entry.coverage.total} ${entry.coverage.unit}`;
}

export function exposureLabel(entry: Pick<CompanyBoxEntry, "exposure" | "coverage">) {
  return entry.exposure === "direct"
    ? `One tool per ${entry.coverage.unit === "tools" ? "tool" : "operation"}`
    : `Search, describe and call (${entry.coverage.exposed} ${entry.coverage.unit})`;
}

function failureCopy(code: string | undefined) {
  return errorCopy(new ApiError(code ?? "openapi_unreachable", 502, { error: code ?? "openapi_unreachable" }));
}

type CredentialMode = "keep" | "replace";

function originOf(value: string | null | undefined) {
  try {
    return value ? new URL(value).origin : null;
  } catch {
    return null;
  }
}

function SetupDialog({ entry, open, onOpenChange, secretStoreAvailable, onSaved }: { entry: CompanyBoxEntry | null; open: boolean; onOpenChange: (open: boolean) => void; secretStoreAvailable: boolean; onSaved: (result: CompanyBoxResult) => void }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [values, setValues] = useState<Partial<Record<CompanyBoxCredentialKey, string>>>({});
  const [modes, setModes] = useState<Partial<Record<CompanyBoxCredentialKey, CredentialMode>>>({});
  const savedOrigin = originOf(entry?.connection?.baseUrl);
  const originChanged = Boolean(savedOrigin && originOf(baseUrl.trim()) && originOf(baseUrl.trim()) !== savedOrigin && entry?.credentials.some((field) => field.configured));
  const mutation = useMutation({
    mutationFn: () => {
      const credentials: Partial<Record<CompanyBoxCredentialKey, string>> = {};
      for (const field of entry!.credentials) {
        const saved = field.configured && modes[field.key] !== "replace" && !originChanged;
        if (!saved && values[field.key]) credentials[field.key] = values[field.key];
      }
      return setupCompanyBoxEntry(entry!.id, { baseUrl: baseUrl.trim(), ...(Object.keys(credentials).length ? { credentials } : {}) });
    },
    onSuccess: (result) => {
      setValues({});
      onSaved(result);
    },
  });
  useEffect(() => {
    if (!open) return;
    setBaseUrl(entry?.connection?.baseUrl ?? "");
    setValues({});
    setModes({});
    mutation.reset();
  }, [open, entry?.id]);
  if (!entry) return null;
  // Saved credentials never follow the app to a new origin.
  // MCP entries send the credential fields together as one header.
  const together = entry.source === "mcp";
  const anyReplacing = originChanged || entry.credentials.some((field) => !field.configured || modes[field.key] === "replace");
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!mutation.isPending) onOpenChange(next); }}>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="form-dialog custom-connector-dialog company-box-dialog">
      <header className="modal-header"><div><p className="eyebrow">Company Box</p><Dialog.Title>{entry.installed ? `Edit ${entry.displayName}` : `Set up ${entry.displayName}`}</Dialog.Title><Dialog.Description>Installs once for the workspace with its full API ({coverageLabel(entry)}). You choose which agents can use it in Agent grants.</Dialog.Description></div><Dialog.Close asChild><IconButton aria-label="Close setup dialog"><X size={17} /></IconButton></Dialog.Close></header>
      <form id="company-box-form" className="modal-body settings-stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
        <label>App address<input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required placeholder={entry.baseUrlExample ?? "https://app.your-tailnet.ts.net"} inputMode="url" autoComplete="off" /></label>
        <p className="muted-detail field-help">The app's https:// address, usually on your tailnet (*.ts.net). Marketplace itself must be able to reach your tailnet.</p>
        {entry.credentials.length > 0 && <fieldset className="header-rows">
          <legend>Credentials</legend>
          <p className="muted-detail">Encrypted on the server and never shown again.</p>
          {originChanged && <p className="inline-error" role="status"><AlertTriangle size={14} /><span>New address: enter the credentials again. Saved ones are never sent to a different host.</span></p>}
          {entry.credentials.map((field) => {
            const saved = field.configured && modes[field.key] !== "replace" && !originChanged;
            return saved ? <div className="header-row header-row--saved" key={field.key}>
              <span>{field.label}</span>
              <span className="header-row__saved"><KeyRound size={13} />Saved{field.fingerprint ? <> · <code>{field.fingerprint}</code></> : null}</span>
              <div className="dialog-actions"><Button size="small" type="button" onClick={() => setModes((current) => together ? Object.fromEntries(entry.credentials.map((item) => [item.key, "replace"])) : { ...current, [field.key]: "replace" })}>Replace</Button></div>
            </div> : <div className="header-row" key={field.key}>
              <span>{field.label}</span>
              <input aria-label={field.label} type={field.secret ? "password" : "text"} autoComplete={field.secret ? "new-password" : "off"} value={values[field.key] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} required placeholder={field.secret ? "Secret value" : field.label} />
              {field.configured && !originChanged ? <div className="dialog-actions"><Button size="small" type="button" onClick={() => { setModes((current) => together ? {} : { ...current, [field.key]: "keep" }); setValues((current) => together ? {} : { ...current, [field.key]: "" }); }}><Undo2 size={13} />Keep saved</Button></div> : <span />}
            </div>;
          })}
        </fieldset>}
        {anyReplacing && entry.credentials.length > 0 && !secretStoreAvailable && <p className="inline-error"><AlertTriangle size={14} /><span>Secret storage isn't set up on this Marketplace, so credentials can't be saved.</span></p>}
        {mutation.error && <InlineError error={mutation.error} />}
      </form>
      <footer className="modal-footer"><span>Approval is checked, then the connection is tested.</span><div className="dialog-actions"><Dialog.Close asChild><Button type="button" disabled={mutation.isPending}>Cancel</Button></Dialog.Close><Button tone="primary" type="submit" form="company-box-form" disabled={mutation.isPending}>{mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{entry.installed ? "Save and test" : "Set up and test"}</Button></div></footer>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}

function EntryCard({ entry, onSetup, onChanged, onNotice }: { entry: CompanyBoxEntry; onSetup: () => void; onChanged: () => void; onNotice: (notice: string) => void }) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const test = useMutation({
    mutationFn: () => testCompanyBoxEntry(entry.id),
    onSuccess: (result) => onNotice(result.ok ? `${entry.displayName} is connected.` : `${entry.displayName}: ${failureCopy(result.error).title}.`),
    onSettled: onChanged,
  });
  const remove = useMutation({ mutationFn: () => removeCompanyBoxEntry(entry.id), onSuccess: () => { setConfirmRemove(false); onNotice(`${entry.displayName} was removed.`); onChanged(); } });
  const busy = test.isPending || remove.isPending;
  const state = entry.installed ? (entry.connection?.state ?? "pending") : "available";
  const savedCredentials = entry.credentials.filter((field) => field.configured);
  return <article className="custom-connector company-box-entry" aria-label={entry.displayName}>
    <header>
      <span className="catalog-monogram">{entry.displayName.slice(0, 2).toUpperCase()}</span>
      <div><strong>{entry.displayName}</strong><code>{entry.connection?.baseUrl ?? `${SOURCE_LABEL[entry.source]} · v${entry.appVersion}`}</code><p>{entry.description}</p></div>
      <div className="custom-connector__tags"><Tag tone={entry.installed ? statusTone(state) : "default"}>{entry.installed ? statusLabel(state) : "Not set up"}</Tag><Tag tone="accent">{coverageLabel(entry)}</Tag><Tag>{SOURCE_LABEL[entry.source]}</Tag></div>
    </header>
    <dl className="fact-list custom-connector__facts">
      <dt>Coverage</dt><dd>{coverageLabel(entry)}{entry.coverage.excluded ? ` · ${entry.coverage.excluded} left out on purpose` : ""}</dd>
      <dt>Agents see</dt><dd>{exposureLabel(entry)}</dd>
      {entry.outward > 0 && <><dt>Needs approval</dt><dd>{entry.outward} outward {entry.outward === 1 ? "action" : "actions"} (sending, publishing), every time</dd></>}
      {entry.credentials.length > 0 && <><dt>Credentials</dt><dd>{savedCredentials.length ? savedCredentials.map((field) => `${field.label}${field.fingerprint ? ` · ${field.fingerprint}` : ""}`).join(", ") : "Not saved"}</dd></>}
      {entry.connection && <><dt>Checked</dt><dd>{formatWhen(entry.connection.updatedAt)}</dd></>}
    </dl>
    {entry.installed && entry.connection && entry.connection.state !== "connected" && <p className="inline-error" role="status"><AlertTriangle size={14} /><span>{entry.connection.detail}</span></p>}
    {test.error && <InlineError error={test.error} />}
    {remove.error && <InlineError error={remove.error} />}
    <div className="dialog-actions custom-connector__actions">
      <Button size="small" tone={entry.installed ? undefined : "primary"} disabled={busy} onClick={onSetup}><Settings2 size={14} />{entry.installed ? "Edit" : "Set up"}</Button>
      {entry.installed && <Button size="small" disabled={busy} onClick={() => { remove.reset(); test.mutate(); }}>{test.isPending ? <LoaderCircle className="spin" size={14} /> : <PlugZap size={14} />}Test connection</Button>}
      {entry.installed && (confirmRemove ? <><Button size="small" tone="danger" disabled={busy} onClick={() => remove.mutate()}>{remove.isPending ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}Confirm remove</Button><Button size="small" disabled={busy} onClick={() => setConfirmRemove(false)}>Keep</Button></> : <Button size="small" disabled={busy} onClick={() => { test.reset(); setConfirmRemove(true); }}><Trash2 size={14} />Remove</Button>)}
    </div>
    {confirmRemove && <p className="muted-detail">Removing deletes the saved credentials and every agent's access to {entry.displayName}.</p>}
  </article>;
}

const APPROVAL_STATE_LABEL: Record<CompanyBoxApproval["state"], string> = {
  pending: "Waiting",
  resolving: "Checking approval",
  executing: "Running",
  succeeded: "Approved · ran",
  failed: "Approved · failed",
  denied: "Denied",
  expired: "Expired",
};

const DISPLAY_STRING_CHARS = 300;
const DISPLAY_ARRAY_ITEMS = 50;
const DISPLAY_DEPTH = 8;

function Truncated({ children }: { children: string }) {
  return <em className="args-truncated">{children}</em>;
}

/** Key-sorted view of the full stored arguments; display truncation is always marked. */
export function ArgumentsView({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) return <code>null</code>;
  if (typeof value === "string") {
    return value.length > DISPLAY_STRING_CHARS
      ? <span><code>{JSON.stringify(value.slice(0, DISPLAY_STRING_CHARS))}</code> <Truncated>{`truncated for display: ${value.length.toLocaleString()} characters in full`}</Truncated></span>
      : <code>{JSON.stringify(value)}</code>;
  }
  if (typeof value !== "object") return <code>{String(value)}</code>;
  if (depth >= DISPLAY_DEPTH) return <Truncated>nested value truncated for display</Truncated>;
  if (Array.isArray(value)) {
    if (!value.length) return <code>[]</code>;
    return <ol className="args-view" start={0}>{value.slice(0, DISPLAY_ARRAY_ITEMS).map((item, index) => <li key={index}><ArgumentsView value={item} depth={depth + 1} /></li>)}{value.length > DISPLAY_ARRAY_ITEMS && <li><Truncated>{`${value.length - DISPLAY_ARRAY_ITEMS} more items truncated for display`}</Truncated></li>}</ol>;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (!entries.length) return <code>{"{}"}</code>;
  return <dl className="args-view">{entries.map(([key, child]) => <div key={key}><dt>{key}</dt><dd><ArgumentsView value={child} depth={depth + 1} /></dd></div>)}</dl>;
}

/**
 * A held channel post: everything the digest covers, as plain text. The
 * owner sees the destination, the full text, every file with its SHA-256
 * prefix, transcripts and the digest prefix before approving (spec §4.6, §6).
 */
export function ChannelHoldView({ summary, payload }: { summary: ChannelApprovalSummary; payload: ChannelPayloadView | null | undefined }) {
  const channels = useQuery({ queryKey: ["channels"], queryFn: getChannels, retry: false, staleTime: 30_000 });
  const channel = channels.data?.configured ? channels.data.channels.find((entry) => entry.id === summary.channelId) : undefined;
  const transcripts = payload && "canonical" in payload ? transcriptsFromCanonical(payload.canonical) : [];
  const voiceFallback = payload && "fallbacks" in payload && payload.fallbacks.some((entry) => entry.startsWith("voice"));
  return <div className="channel-hold" aria-label="Channel post">
    <dl className="fact-list channel-hold__facts">
      <dt>Destination</dt><dd><strong>{summary.label ?? "Unknown channel"}</strong>{summary.provider ? ` · ${providerLabel(summary.provider)}` : ""}{channel ? <> · <span className="destination-title">{channel.destination.title}</span> ({channel.destination.type})</> : null}</dd>
      {summary.action && <ChannelActionFacts action={summary.action} />}
      <dt>When</dt><dd>{summary.mode === "scheduled" ? `Scheduled for ${formatWhen(summary.sendAt)}` : "Sends when you approve"}</dd>
      <dt>Digest</dt><dd><code className="digest-prefix" title={summary.digest}>{summary.digestPrefix || digestPrefix(summary.digest)}</code></dd>
      <dt>Buzz code</dt><dd><code className="digest-prefix" title={BUZZ_CODE_HINT}>{digestPrefix(summary.digest, BUZZ_CODE_CHARS)}</code><p className="muted-detail">{BUZZ_CODE_HINT}</p></dd>
    </dl>
    {payload === undefined ? <span className="muted-detail">Loading the post…</span>
      : payload === null ? <p className="inline-error" role="status"><AlertTriangle size={14} /><span>The post or its channel is no longer available.</span></p>
      : "error" in payload ? <p className="inline-error" role="status"><AlertTriangle size={14} /><span>This post can't be sent as held any more ({errorCopy(new ApiError(payload.error, 409, { error: payload.error })).title}). Deny it; the agent can ask again.</span></p>
      : <>
        {!payload.matchesHeldDigest && <p className="inline-error" role="alert"><AlertTriangle size={14} /><span>The destination or a file changed after the agent asked. Approving will not send it; deny it instead.</span></p>}
        {summary.action?.op !== "react" && summary.action?.op !== "delete" && <div className="channel-hold__text"><span className="eyebrow">{summary.action?.op === "edit" ? "New text" : "Text"} ({payload.text.length.toLocaleString()} characters)</span><pre className="plain-text">{payload.text || "(no text)"}</pre></div>}
        {payload.files.length > 0 && <div><span className="eyebrow">Attachments</span><ul className="hold-files">{payload.files.map((file) => <li key={`${file.sha256}-${file.name}`}>
          <strong className="hold-file__name">{file.name}</strong>
          <span>{file.kind} · {typeName(file.contentType)} · {formatBytes(file.bytes)}</span>
          <code title={file.sha256}>sha256 {digestPrefix(file.sha256)}</code>
          {file.kind === "image" && <small className="muted-detail">No preview is available yet. Compare the hash with the file you expect.</small>}
        </li>)}</ul></div>}
        {transcripts.length > 0 && <div><span className="eyebrow">Voice transcript</span>{transcripts.map((entry, index) => <pre key={index} className="plain-text">{entry.transcript}</pre>)}</div>}
        {payload.fallbacks.length > 0 && <p className="muted-detail">Fallback applied: {payload.fallbacks.join(", ")}.{voiceFallback ? " The voice note is sent as an audio file and its transcript is part of the text above." : ""}</p>}
      </>}
  </div>;
}

/**
 * Routes v2: what the held operation does. A reaction shows its emoji, an edit or delete the start of the message
 * Marketplace posted (from its receipt), a direct message the person's name and whether this is the first message.
 */
function ChannelActionFacts({ action }: { action: ChannelActionView }) {
  return <>
    {action.op === "react" && <><dt>Reaction</dt><dd>{action.remove ? "Remove " : "Add "}<code>{action.emoji}</code></dd></>}
    {(action.op === "react" || action.op === "edit" || action.op === "delete") && <>
      <dt>{action.op === "edit" ? "Message to change" : action.op === "delete" ? "Message to delete" : "On message"}</dt>
      <dd>{action.targetExcerpt ? <pre className="plain-text">{action.targetExcerpt}</pre> : <span className="muted-detail">The original text is no longer kept.</span>}<small className="muted-detail">Message id <code>{action.targetMessageId}</code></small></dd>
    </>}
    {action.op === "dm" && <><dt>Person</dt><dd>{action.person ? <><strong>{action.person.displayName}</strong>{action.person.approved ? "" : " · first message: after you approve, later messages may be covered by a standing grant with direct messages"}</> : "Unknown person"}</dd></>}
    {action.poll && <><dt>Poll</dt><dd><strong>{action.poll.question}</strong><ul className="plain-list">{action.poll.options.map((option) => <li key={option}>{option}</li>)}</ul></dd></>}
    {action.mentions?.length ? <><dt>Mentions</dt><dd>{action.mentions.join(", ")}</dd></> : null}
    {action.markup && <><dt>Markup</dt><dd><code>{action.markup}</code></dd></>}
  </>;
}

function channelDecisionNotice(approval: CompanyBoxApproval, result: Awaited<ReturnType<typeof decideCompanyBoxApproval>>) {
  const label = approval.channel?.label ?? "the channel";
  const what = actionTitle(approval.channel?.action, label);
  if (result.channel?.scheduled) return `Approved. The post to ${label} is sent at its scheduled time.`;
  if (result.ok) return approval.channel?.action && approval.channel.action.op !== "post" && approval.channel.action.op !== "poll" ? `Approved and done: ${what}.` : `Approved and posted to ${label}.`;
  const code = typeof result.channel?.error === "string" ? result.channel.error : result.approval.error ?? undefined;
  return `Approved, but "${what}" wasn't sent: ${failureCopy(code).title}.`;
}

function ApprovalRow({ approval, onDecided }: { approval: CompanyBoxApproval; onDecided: (notice: string) => void }) {
  const pendingRow = approval.state === "pending";
  const channelHold = approval.channel;
  const full = useQuery({ queryKey: ["company-box-approval", approval.id], queryFn: () => getCompanyBoxApproval(approval.id), enabled: pendingRow, retry: false });
  const decide = useMutation({
    mutationFn: (decision: "approve" | "deny") => decideCompanyBoxApproval(approval.id, decision),
    onSuccess: (result, decision) =>
      onDecided(
        decision === "deny"
          ? channelHold ? `Denied the post to ${channelHold.label ?? "the channel"} from ${approval.agentId}.` : `Denied ${approval.operation.title} for ${approval.agentId}.`
          : channelHold
            ? channelDecisionNotice(approval, result)
            : result.approval.state === "succeeded"
              ? `Approved and ran ${approval.operation.title}.`
              : `Approved, but ${approval.operation.title} failed: ${failureCopy(result.approval.error ?? undefined).title}.`,
      ),
  });
  const pending = approval.state === "pending";
  const payload = channelHold ? (full.data ? full.data.payloadView ?? null : undefined) : undefined;
  const reviewable = channelHold ? Boolean(payload && !("error" in payload) && payload.matchesHeldDigest) : Boolean(full.data);
  const title = channelHold ? actionTitle(channelHold.action, channelHold.label ?? "a channel") : `${approval.app} · ${approval.operation.title}`;
  return <div className="company-box-approval" aria-label={channelHold ? title : `${approval.app}: ${approval.operation.title}`}>
    <div>
      <strong>{title}</strong>
      {!channelHold && approval.operation.method && <code>{approval.operation.method} {approval.operation.path}</code>}
      <p>Requested by <strong>{approval.agentId}</strong> {formatWhen(approval.createdAt)}{pending ? ` · expires ${formatWhen(approval.expiresAt)}` : ""}</p>
      {channelHold
        ? pendingRow
          ? full.error ? <InlineError error={full.error} /> : <ChannelHoldView summary={channelHold} payload={payload} />
          : <p className="muted-detail">Digest <code title={channelHold.digest}>{channelHold.digestPrefix}</code>{channelHold.postStatus ? ` · post ${channelHold.postStatus}` : ""}</p>
        : pendingRow
          ? <div className="company-box-approval__args" aria-label="Arguments">{full.data ? <ArgumentsView value={full.data.arguments} /> : full.error ? <InlineError error={full.error} /> : <span className="muted-detail">Loading arguments…</span>}</div>
          : <pre className="company-box-approval__args">{approval.argumentsPreview}</pre>}
      {decide.error && <InlineError error={decide.error} />}
    </div>
    {pending ? <div className="dialog-actions">
      <Button size="small" tone="primary" disabled={decide.isPending || !reviewable} title={reviewable ? undefined : channelHold ? "Review the post first" : "Review the arguments first"} onClick={() => decide.mutate("approve")}>{decide.isPending && decide.variables === "approve" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Approve</Button>
      <Button size="small" disabled={decide.isPending} onClick={() => decide.mutate("deny")}><CircleSlash size={14} />Deny</Button>
    </div> : <Tag tone={approval.state === "succeeded" ? "success" : approval.state === "failed" || approval.state === "denied" ? "danger" : "default"}>{APPROVAL_STATE_LABEL[approval.state]}</Tag>}
  </div>;
}

/**
 * Outward calls agents asked for; each runs once, only after you approve it.
 * One queue for every outward call: the Channels view shows the same panel
 * narrowed to channel posts (`only="channel"`).
 */
export function ApprovalsPanel({ onNotice, only }: { onNotice: (notice: string) => void; only?: "channel" }) {
  const queryClient = useQueryClient();
  const approvals = useQuery({ queryKey: ["company-box-approvals"], queryFn: () => getCompanyBoxApprovals(), retry: false, refetchInterval: 30_000 });
  const items = (approvals.data?.approvals ?? []).filter((approval) => only !== "channel" || approval.channel);
  const pending = items.filter((approval) => approval.state === "pending");
  const recent = items.filter((approval) => approval.state !== "pending").slice(0, 10);
  const decided = (notice: string) => { onNotice(notice); void queryClient.invalidateQueries({ queryKey: ["company-box-approvals"] }); };
  if (approvals.error) return <InlineError error={approvals.error} />;
  if (!items.length) return null;
  return <section className="company-box-approvals" aria-labelledby={only ? "channel-approvals-heading" : "company-box-approvals-heading"}>
    <div className="section-heading"><div><p className="eyebrow">Needs you</p><h3 id={only ? "channel-approvals-heading" : "company-box-approvals-heading"}><Hourglass size={15} aria-hidden="true" /> {only === "channel" ? "Posts waiting for approval" : "Approvals"}</h3></div><Tag tone={pending.length ? "warning" : "default"} aria-label={`${pending.length} waiting`}>{pending.length}</Tag></div>
    {pending.length ? pending.map((approval) => <ApprovalRow key={approval.id} approval={approval} onDecided={decided} />) : <p className="muted-detail">Nothing waiting.</p>}
    {recent.length > 0 && <details><summary>Recent decisions</summary>{recent.map((approval) => <ApprovalRow key={approval.id} approval={approval} onDecided={decided} />)}</details>}
  </section>;
}

export function CompanyBoxSection({ onChanged }: { onChanged: () => void }) {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ["company-box"], queryFn: getCompanyBox, retry: false });
  const [setupId, setSetupId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const changed = () => { void queryClient.invalidateQueries({ queryKey: ["company-box"] }); void queryClient.invalidateQueries({ queryKey: ["custom-connectors"] }); onChanged(); };
  const entries = list.data?.entries ?? [];
  const setupEntry = entries.find((entry) => entry.id === setupId) ?? null;
  return <section className="custom-connectors company-box" aria-labelledby="company-box-heading">
    <div className="section-heading"><div><p className="eyebrow">Your self-hosted apps</p><h2 id="company-box-heading">{list.data?.collection.label ?? "Company Box"}</h2></div>{entries.length > 0 && <Tag>{entries.length} apps</Tag>}</div>
    <p className="section-copy">{list.data?.collection.description ?? "Your self-hosted apps, whole."} Outward actions <Send size={12} aria-hidden="true" /> always wait for your approval.</p>
    {notice && <p className="inline-success" role="status"><Check size={14} />{notice}</p>}
    <ApprovalsPanel onNotice={setNotice} />
    {list.error ? <StatePanel error={list.error} onRetry={() => void list.refetch()} /> : list.isLoading ? <p className="muted">Loading Company Box…</p> : entries.length ? <div className="custom-connector-list">{entries.map((entry) => <EntryCard key={entry.id} entry={entry} onSetup={() => { setNotice(null); setSetupId(entry.id); }} onChanged={changed} onNotice={setNotice} />)}</div> : <div className="collection-empty compact"><Boxes /><h3>No apps in the Company Box yet</h3><p>Apps appear here once their catalog entries ship with this Marketplace.</p></div>}
    {list.data && list.data.unavailable.length > 0 && <p className="muted-row">{list.data.unavailable.length} {list.data.unavailable.length === 1 ? "entry is" : "entries are"} hidden because {list.data.unavailable.length === 1 ? "it fails" : "they fail"} the coverage check.</p>}
    <SetupDialog
      entry={setupEntry}
      open={setupEntry !== null}
      onOpenChange={(open) => { if (!open) setSetupId(null); }}
      secretStoreAvailable={list.data?.secretStoreAvailable ?? true}
      onSaved={(result) => { setSetupId(null); setNotice(result.ok ? `${result.entry.displayName} is connected.` : `${result.entry.displayName} was saved, but the test failed: ${failureCopy(result.error).title}.`); changed(); }}
    />
  </section>;
}
