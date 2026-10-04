import { useMemo, useState } from "react";
import { Bot, Boxes, Clock3, ExternalLink, KeyRound, LoaderCircle, PackageCheck, Plug, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { Button, Tag } from "@tealbrick/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getAgentActionCatalog, getAgentGrants, redeemAgentGrant, requestAgentGrant } from "./agent-grants-api";
import type {
  AgentActionCatalogEntry,
  AgentConsentSummary,
  AgentGrantRequestResponse,
  ConnectorCapability,
  AgentGrantSummary,
  AgentGrantsResponse,
  HandoffRequestSummary,
} from "./types";
import { formatWhen, InlineError, StatePanel, statusLabel, statusTone, words } from "./ui";

function newIdempotencyKey() {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `marketplace-${random}`.slice(0, 100);
}

function displayGrantState(grant: AgentGrantSummary) {
  return grant.state === "active" && grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()
    ? "expired"
    : grant.state;
}

function displayRequestState(request: HandoffRequestSummary) {
  return request.state === "pending" && Date.parse(request.expiresAt) <= Date.now()
    ? "expired"
    : request.state;
}

function consentAsGrant(consent: AgentConsentSummary): AgentGrantSummary {
  return {
    id: consent.id,
    workspaceSlug: consent.productTenantId,
    agentId: consent.agentId,
    pluginId: consent.pluginId,
    actionKey: consent.actionKey,
    capability: consent.capability,
    connectionId: consent.connectionId,
    accountId: consent.accountId,
    resourceKind: consent.resourceKind,
    resourceRef: consent.resourceRef,
    state: consent.state,
    expiresAt: null,
    createdAt: consent.createdAt,
    updatedAt: consent.updatedAt,
    consentId: consent.consentId,
    deploymentId: consent.deploymentId,
    durableConsent: true,
  };
}

function AgentGrantRow({ grant, onRevoke }: { grant: AgentGrantSummary; onRevoke: (grant: AgentGrantSummary) => void }) {
  const state = displayGrantState(grant);
  return (
    <article className="agent-grant-row" data-testid={`agent-grant-${grant.id}`}>
      <header className="agent-grant-row__header">
        <div className="agent-grant-row__identity">
          <span className="agent-grant-row__icon"><Bot size={17} /></span>
          <div>
            <strong>{grant.pluginId}</strong>
            <code>{grant.actionKey}</code>
          </div>
        </div>
        <Tag tone={statusTone(state)}>{statusLabel(state)}</Tag>
      </header>
      <div className="agent-grant-row__scope">
        <div><span>Agent</span><code>{grant.agentId}</code></div>
        <div><span>Capability</span><code>{grant.capability}</code></div>
        <div><span>Account</span><code>{grant.accountId}</code></div>
        <div><span>Resource scope</span><code>{grant.resourceKind}:{grant.resourceRef}</code></div>
      </div>
      <footer className="agent-grant-row__footer">
        <p><Clock3 size={13} />{grant.expiresAt ? (state === "expired" ? `Expired ${formatWhen(grant.expiresAt)}` : `Expires ${formatWhen(grant.expiresAt)}`) : "Durable consent · no lease expiry"}<span>·</span>Granted {formatWhen(grant.createdAt)}</p>
        {grant.state === "active" && <Button size="small" tone="danger" aria-label={`Revoke grant for ${grant.agentId}`} onClick={() => onRevoke(grant)}><XCircle size={14} />Revoke</Button>}
      </footer>
    </article>
  );
}

function HandoffRequestRow({ request, onRedeem, redeeming }: { request: HandoffRequestSummary; onRedeem: (request: HandoffRequestSummary) => void; redeeming: boolean }) {
  const state = displayRequestState(request);
  const canReconcile = state === "pending";
  return (
    <article className="agent-grant-row handoff-request-row" data-testid={`handoff-request-${request.requestId}`}>
      <header className="agent-grant-row__header">
        <div className="agent-grant-row__identity">
          <span className="agent-grant-row__icon"><ShieldCheck size={17} /></span>
          <div>
            <strong>Portal consent request</strong>
            <code>{request.requestId}</code>
          </div>
        </div>
        <Tag tone={statusTone(state)}>{statusLabel(state)}</Tag>
      </header>
      <div className="agent-grant-row__scope">
        <div><span>Agent</span><code>{request.agentId}</code></div>
        <div><span>Selection</span><code>{request.selection.pluginId} · {request.selection.actionKey}</code></div>
        <div><span>Account</span><code>{request.selection.accountId}</code></div>
        <div><span>Deployment</span><code>{request.deploymentId}</code></div>
      </div>
      <footer className="agent-grant-row__footer">
        <p><Clock3 size={13} />Expires {formatWhen(request.expiresAt)}<span>·</span>Updated {formatWhen(request.updatedAt)}</p>
        <div className="agent-grant-row__actions">
          {canReconcile && <a className="dg-button dg-button--small" href={request.approvalUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />Open Portal review</a>}
          {canReconcile && <Button size="small" tone="primary" disabled={redeeming} onClick={() => onRedeem(request)}>{redeeming ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}Reconcile approval</Button>}
        </div>
      </footer>
    </article>
  );
}

const CAPABILITY_COPY: Record<ConnectorCapability, { badge: string; tone: "default" | "warning" | "danger"; detail: string }> = {
  "connector.observe": { badge: "Read only", tone: "default", detail: "The agent can look up information through this account. It can't change anything." },
  "connector.dispatch": { badge: "Can make changes", tone: "warning", detail: "The agent can create and update items through this account, for example opening an issue or sending a message." },
  "connector.admin": { badge: "Full control", tone: "danger", detail: "The agent can create, change, and delete items and manage settings through this account." },
};

function connectorsFrom(actions: AgentActionCatalogEntry[]) {
  const connectors = new Map<string, { pluginId: string; pluginName: string }>();
  for (const action of actions) {
    if (!connectors.has(action.pluginId)) connectors.set(action.pluginId, { pluginId: action.pluginId, pluginName: action.pluginName });
  }
  return [...connectors.values()];
}

function accountLabel(account: { accountId: string; label?: string }) {
  return account.label ? `${account.label} (${account.accountId})` : account.accountId;
}

function RequestGrantForm({ data, workspaceSlug, onRequested, onNavigate }: { data: AgentGrantsResponse; workspaceSlug: string; onRequested: (result: AgentGrantRequestResponse) => void; onNavigate?: (section: "catalog" | "installed") => void }) {
  const seedRequest = data.handoffRequests?.[0];
  const seedConsent = data.consents?.[0];
  const catalog = useQuery({
    queryKey: ["agent-action-catalog", workspaceSlug],
    queryFn: () => getAgentActionCatalog(workspaceSlug),
    enabled: Boolean(workspaceSlug),
    retry: false,
  });
  const actions = catalog.data?.actions ?? [];
  const connectors = useMemo(() => connectorsFrom(actions), [actions]);
  const [deploymentId, setDeploymentId] = useState(seedRequest?.deploymentId ?? seedConsent?.deploymentId ?? "");
  const [agentId, setAgentId] = useState(seedRequest?.agentId ?? seedConsent?.agentId ?? "");
  const [pluginChoice, setPluginChoice] = useState(seedRequest?.selection.pluginId ?? seedConsent?.pluginId ?? "");
  const [actionChoice, setActionChoice] = useState(seedRequest?.selection.actionKey ?? seedConsent?.actionKey ?? "");
  const [accountChoice, setAccountChoice] = useState(seedRequest?.selection.accountId ?? seedConsent?.accountId ?? "");
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  // Derive the effective picks from what the catalog currently publishes, so
  // stale seeds or removed connectors never reach the request.
  const pluginId = connectors.some((connector) => connector.pluginId === pluginChoice)
    ? pluginChoice
    : connectors.length === 1 ? connectors[0]!.pluginId : "";
  const connectorActions = actions.filter((action) => action.pluginId === pluginId);
  const action = connectorActions.find((entry) => entry.actionKey === actionChoice)
    ?? (connectorActions.length === 1 ? connectorActions[0] : undefined);
  const accountId = action?.accounts.some((account) => account.accountId === accountChoice)
    ? accountChoice
    : action?.accounts.length === 1 ? action.accounts[0]!.accountId : "";
  const resourceRef = accountId ? `account:${accountId}` : "";

  const request = useMutation({
    mutationFn: () => {
      if (!action || !accountId) throw new Error("No published action selected.");
      return requestAgentGrant({
        deploymentId: deploymentId.trim(),
        agentId: agentId.trim(),
        selection: { pluginId: action.pluginId, actionKey: action.actionKey, accountId, resourceKind: action.resourceKind, resourceRef },
        idempotencyKey,
      });
    },
    onSuccess: (result) => {
      onRequested(result);
      setIdempotencyKey(newIdempotencyKey());
    },
  });
  const valid = Boolean(deploymentId.trim() && agentId.trim() && action && accountId);
  const capability = action ? CAPABILITY_COPY[action.capability] : null;

  let picker;
  if (catalog.isLoading) {
    picker = <p className="grant-catalog-state" role="status"><LoaderCircle className="spin" size={15} />Loading the actions your connectors make available to agents…</p>;
  } else if (catalog.error) {
    picker = <div className="grant-catalog-state"><InlineError error={catalog.error} /><Button size="small" onClick={() => void catalog.refetch()}><RefreshCw size={14} />Retry</Button></div>;
  } else if (!actions.length) {
    picker = <div className="collection-empty compact grant-catalog-empty"><Plug /><h3>Install and connect a connector first</h3><p>Agents can only be given access to actions from connectors that are installed, connected to an account, and turned on in this workspace.</p>{onNavigate && <div className="grant-catalog-empty__actions"><Button tone="primary" size="small" onClick={() => onNavigate("catalog")}><Boxes size={14} />Browse the catalog</Button><Button size="small" onClick={() => onNavigate("installed")}><PackageCheck size={14} />View installed</Button></div>}</div>;
  } else {
    picker = <>
      <div className="form-grid two">
        <label>Connector<select aria-label="Connector" value={pluginId} onChange={(event) => { setPluginChoice(event.target.value); setActionChoice(""); setAccountChoice(""); }} required><option value="" disabled>Choose a connector</option>{connectors.map((connector) => <option key={connector.pluginId} value={connector.pluginId}>{connector.pluginName}</option>)}</select></label>
        <label>Action<select aria-label="Action" value={action?.actionKey ?? ""} onChange={(event) => { setActionChoice(event.target.value); setAccountChoice(""); }} disabled={!pluginId} required><option value="" disabled>{pluginId ? "Choose an action" : "Choose a connector first"}</option>{connectorActions.map((entry) => <option key={entry.actionKey} value={entry.actionKey}>{entry.label} — {CAPABILITY_COPY[entry.capability].badge}</option>)}</select></label>
        <label>Connected account<select aria-label="Connected account" value={accountId} onChange={(event) => setAccountChoice(event.target.value)} disabled={!action} required><option value="" disabled>{action ? "Choose an account" : "Choose an action first"}</option>{action?.accounts.map((account) => <option key={account.accountId} value={account.accountId}>{accountLabel(account)}</option>)}</select></label>
        <label>Resource scope<input value={resourceRef} readOnly aria-label="Resource scope" placeholder="Set by the connected account" /></label>
      </div>
      {action && capability && <div className="grant-capability" data-testid="grant-capability"><Tag tone={capability.tone}>{capability.badge}</Tag><p>{capability.detail}{action.description ? <span> {action.description}</span> : null}</p></div>}
      <dl className="contract-list grant-request-selection"><dt>Connector</dt><dd>{action?.pluginName ?? "—"}</dd><dt>Action</dt><dd>{action ? <code>{action.actionKey}</code> : "—"}</dd><dt>Access level</dt><dd>{capability?.badge ?? "—"}</dd><dt>Resource kind</dt><dd>{action?.resourceKind ?? "—"}</dd><dt>Workspace</dt><dd>{workspaceSlug}</dd></dl>
    </>;
  }

  return (
    <section className="grant-request-panel">
      <header className="section-heading">
        <div><p className="eyebrow">Portal handoff</p><h2>Request connector access</h2></div>
        <Tag tone="accent">{data.handoffContractVersion}</Tag>
      </header>
      <p className="section-copy">Pick an action one of your connectors makes available to agents. Marketplace sends that bounded selection to Teal Brick Portal, where a person approves it; this browser never receives a Portal session, agent credential, or runtime lease.</p>
      <form className="grant-request-form" onSubmit={(event) => { event.preventDefault(); request.mutate(); }}>
        <div className="form-grid two">
          <label>Portal deployment ID<input value={deploymentId} onChange={(event) => setDeploymentId(event.target.value)} placeholder="From the Portal launch context" required /></label>
          <label>Agent selection<input value={agentId} onChange={(event) => setAgentId(event.target.value)} placeholder="Portal-attested agent" required /></label>
        </div>
        {picker}
        {request.error && <InlineError error={request.error} />}
        <div className="grant-request-form__footer"><span>Idempotency is retained for this request attempt: <code>{idempotencyKey}</code></span><Button tone="primary" type="submit" disabled={!valid || request.isPending}>{request.isPending ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}Request Portal consent</Button></div>
      </form>
    </section>
  );
}

export function AgentGrantsPage({ workspaceSlug, onRevoke, onNavigate }: { workspaceSlug: string; onRevoke: (grant: AgentGrantSummary) => void; onNavigate?: (section: "catalog" | "installed") => void }) {
  const queryClient = useQueryClient();
  const grants = useQuery({
    queryKey: ["agent-grants", workspaceSlug],
    queryFn: () => getAgentGrants(workspaceSlug),
    enabled: Boolean(workspaceSlug),
    retry: false,
  });
  const [requestNotice, setRequestNotice] = useState<AgentGrantRequestResponse | null>(null);
  const redeem = useMutation({
    mutationFn: (request: HandoffRequestSummary) => redeemAgentGrant({ deploymentId: request.deploymentId, requestId: request.requestId }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agent-grants", workspaceSlug] }),
  });
  const data = grants.data;
  const handoffRequests = data?.handoffRequests ?? [];
  const durableConsents = data?.consents ?? [];
  const visibleGrants = useMemo(() => {
    if (!data) return [];
    const durableGrantIds = new Set(durableConsents.map((consent) => consent.id));
    return [...durableConsents.map(consentAsGrant), ...data.grants.filter((grant) => !durableGrantIds.has(grant.id))];
  }, [data, durableConsents]);

  if (grants.isLoading) return <section className="collection-page"><div className="collection-empty"><LoaderCircle className="spin" size={28} /><h2>Loading agent grants</h2><p>Reading the operator-safe grant and Portal handoff projection.</p></div></section>;
  if (grants.error) return <section className="collection-page"><StatePanel error={grants.error} onRetry={() => void grants.refetch()} /></section>;

  if (!data) return null;
  return (
    <section className="collection-page">
      <header>
        <div><p className="eyebrow">Scoped Agent access</p><h1>Agent grants</h1><p>Review the account, resource, capability, and consent scope recorded by Marketplace. Portal remains the human approval authority.</p></div>
        <Tag>{visibleGrants.length} grants</Tag>
      </header>
      <div className="contract-gap agent-grant-creation-gap"><ShieldCheck size={18} /><div><strong>Direct grant creation is disabled</strong><p>{data.grantCreation.detail} The supported path below requests Portal consent and waits for explicit approval.</p><small>{words(data.grantCreation.code)}</small></div></div>
      <RequestGrantForm data={data} workspaceSlug={workspaceSlug} onNavigate={onNavigate} onRequested={(result) => { setRequestNotice(result); void queryClient.invalidateQueries({ queryKey: ["agent-grants", workspaceSlug] }); }} />
      {requestNotice && <div className="request-result contract-gap" role="status"><ShieldCheck size={18} /><div><strong>Portal consent request created</strong><p>Open Portal review, approve explicitly, then return here to reconcile request <code>{requestNotice.request.requestId}</code>.</p><a href={requestNotice.request.approvalUrl} target="_blank" rel="noreferrer">Open Portal review <ExternalLink size={13} /></a></div></div>}
      {redeem.error && <div className="grant-redeem-error"><InlineError error={redeem.error} /></div>}
      {handoffRequests.length > 0 && <section className="grant-subsection"><div className="section-heading"><div><p className="eyebrow">Consent workflow</p><h2>Portal requests</h2></div><Tag>{handoffRequests.length}</Tag></div><div className="agent-grants-list">{handoffRequests.map((request) => <HandoffRequestRow key={request.requestId} request={request} onRedeem={(entry) => redeem.mutate(entry)} redeeming={redeem.isPending && redeem.variables?.requestId === request.requestId} />)}</div></section>}
      {visibleGrants.length ? <section className="grant-subsection"><div className="section-heading"><div><p className="eyebrow">Durable access</p><h2>Recorded grants</h2></div><Tag>{visibleGrants.length}</Tag></div><div className="agent-grants-list" aria-label="Agent grants">{visibleGrants.map((grant) => <AgentGrantRow key={grant.id} grant={grant} onRevoke={onRevoke} />)}</div></section> : <div className="collection-empty compact"><KeyRound /><h3>No active grants</h3><p>Approve a Portal request and reconcile it here before any durable consent appears.</p></div>}
    </section>
  );
}
