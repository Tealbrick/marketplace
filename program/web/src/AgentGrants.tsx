import { useMemo, useState } from "react";
import { Bot, Clock3, ExternalLink, KeyRound, LoaderCircle, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { Button, Tag } from "@doppelganger/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getAgentGrants, redeemAgentGrant, requestAgentGrant } from "./agent-grants-api";
import type {
  AgentConsentSummary,
  AgentGrantRequestResponse,
  AgentGrantSelection,
  AgentGrantSummary,
  AgentGrantsResponse,
  HandoffRequestSummary,
} from "./types";
import { errorCopy, formatWhen, StatePanel, statusTone, words } from "./ui";

const SUPPORTED_SELECTION: AgentGrantSelection = {
  pluginId: "github-composio",
  actionKey: "github.list.repositories",
  resourceKind: "github.connected-account",
  accountId: "",
  resourceRef: "",
};

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
        <Tag tone={statusTone(state)}>{words(state)}</Tag>
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
        <Tag tone={statusTone(state)}>{words(state)}</Tag>
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

function RequestGrantForm({ data, workspaceSlug, onRequested }: { data: AgentGrantsResponse; workspaceSlug: string; onRequested: (result: AgentGrantRequestResponse) => void }) {
  const seedRequest = data.handoffRequests?.[0];
  const seedConsent = data.consents?.[0];
  const [deploymentId, setDeploymentId] = useState(seedRequest?.deploymentId ?? seedConsent?.deploymentId ?? "");
  const [agentId, setAgentId] = useState(seedRequest?.agentId ?? seedConsent?.agentId ?? "");
  const [accountId, setAccountId] = useState(seedRequest?.selection.accountId ?? seedConsent?.accountId ?? "");
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const request = useMutation({
    mutationFn: () => requestAgentGrant({
      deploymentId: deploymentId.trim(),
      agentId: agentId.trim(),
      selection: { ...SUPPORTED_SELECTION, accountId: accountId.trim(), resourceRef: `account:${accountId.trim()}` },
      idempotencyKey,
    }),
    onSuccess: (result) => {
      onRequested(result);
      setIdempotencyKey(newIdempotencyKey());
    },
  });
  const valid = Boolean(deploymentId.trim() && agentId.trim() && accountId.trim());
  return (
    <section className="grant-request-panel">
      <header className="section-heading">
        <div><p className="eyebrow">Portal handoff</p><h2>Request connector access</h2></div>
        <Tag tone="accent">{data.handoffContractVersion}</Tag>
      </header>
      <p className="section-copy">Marketplace sends a bounded selection to its server-side Portal handoff. Portal owns the human approval; this browser never receives a Portal session, agent credential, or runtime lease.</p>
      <form className="grant-request-form" onSubmit={(event) => { event.preventDefault(); request.mutate(); }}>
        <div className="form-grid two">
          <label>Portal deployment ID<input value={deploymentId} onChange={(event) => setDeploymentId(event.target.value)} placeholder="From the Portal launch context" required /></label>
          <label>Agent selection<input value={agentId} onChange={(event) => setAgentId(event.target.value)} placeholder="Portal-attested agent" required /></label>
          <label>Connected account ID<input value={accountId} onChange={(event) => setAccountId(event.target.value)} placeholder="e.g. ca_1" required /></label>
          <label>Resource scope<input value={accountId ? `account:${accountId}` : ""} readOnly aria-label="Resource scope" /></label>
        </div>
        <dl className="contract-list grant-request-selection"><dt>Plugin</dt><dd>{SUPPORTED_SELECTION.pluginId}</dd><dt>Action</dt><dd>{SUPPORTED_SELECTION.actionKey}</dd><dt>Resource kind</dt><dd>{SUPPORTED_SELECTION.resourceKind}</dd><dt>Workspace</dt><dd>{workspaceSlug}</dd></dl>
        {request.error && <p className="inline-error"><XCircle size={14} />{errorCopy(request.error).detail}</p>}
        <div className="grant-request-form__footer"><span>Idempotency is retained for this request attempt: <code>{idempotencyKey}</code></span><Button tone="primary" type="submit" disabled={!valid || request.isPending}>{request.isPending ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}Request Portal consent</Button></div>
      </form>
    </section>
  );
}

export function AgentGrantsPage({ workspaceSlug, onRevoke }: { workspaceSlug: string; onRevoke: (grant: AgentGrantSummary) => void }) {
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
      <RequestGrantForm data={data} workspaceSlug={workspaceSlug} onRequested={(result) => { setRequestNotice(result); void queryClient.invalidateQueries({ queryKey: ["agent-grants", workspaceSlug] }); }} />
      {requestNotice && <div className="request-result contract-gap" role="status"><ShieldCheck size={18} /><div><strong>Portal consent request created</strong><p>Open Portal review, approve explicitly, then return here to reconcile request <code>{requestNotice.request.requestId}</code>.</p><a href={requestNotice.request.approvalUrl} target="_blank" rel="noreferrer">Open Portal review <ExternalLink size={13} /></a></div></div>}
      {redeem.error && <div className="inline-error grant-redeem-error"><XCircle size={14} />{errorCopy(redeem.error).detail}</div>}
      {handoffRequests.length > 0 && <section className="grant-subsection"><div className="section-heading"><div><p className="eyebrow">Consent workflow</p><h2>Portal requests</h2></div><Tag>{handoffRequests.length}</Tag></div><div className="agent-grants-list">{handoffRequests.map((request) => <HandoffRequestRow key={request.requestId} request={request} onRedeem={(entry) => redeem.mutate(entry)} redeeming={redeem.isPending && redeem.variables?.requestId === request.requestId} />)}</div></section>}
      {visibleGrants.length ? <section className="grant-subsection"><div className="section-heading"><div><p className="eyebrow">Durable access</p><h2>Recorded grants</h2></div><Tag>{visibleGrants.length}</Tag></div><div className="agent-grants-list" aria-label="Agent grants">{visibleGrants.map((grant) => <AgentGrantRow key={grant.id} grant={grant} onRevoke={onRevoke} />)}</div></section> : <div className="collection-empty compact"><KeyRound /><h3>No active grants</h3><p>Approve a Portal request and reconcile it here before any durable consent appears.</p></div>}
    </section>
  );
}
