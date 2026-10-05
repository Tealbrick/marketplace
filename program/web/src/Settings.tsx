import { Fragment, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { AlertTriangle, Check, Code2, Copy, LoaderCircle, LogOut, Plug, PlugZap, ShieldCheck, TerminalSquare, Trash2, X } from "lucide-react";
import { Button, IconButton, Tag } from "@tealbrick/ui";

import { getAgentCapabilities, getOpenApi, getProviderSettings, logoutOperator, removeProviderKey, saveProviderSettings, testProviderKey } from "./api";
import type { FrontendBootstrap, OperatorSession, ProviderSettings } from "./types";
import { APPROVAL_STATUS_COPY, type ApprovalStatus, OWNER_APPROVAL_DETAIL } from "./copy";
import { InlineError, StatePanel, words } from "./ui";

function keySourceCopy(source: string | null) {
  if (source === "program") return "saved in Marketplace";
  if (source === "bootstrap-environment") return "provided by your deployment";
  return null;
}

function ProviderSettingsPanel() {
  const settings = useQuery({ queryKey: ["provider-settings"], queryFn: getProviderSettings, retry: false });
  const [draft, setDraft] = useState<ProviderSettings["values"] & { composioApiKey: string }>({ composioBaseUrl: "", composioDefaultUserId: "", composioDefaultConnectedAccountId: "", composioApiKey: "" });
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { if (settings.data) setDraft({ ...settings.data.values, composioApiKey: "" }); }, [settings.data]);
  const resetFeedback = () => { setNotice(null); mutation.reset(); test.reset(); remove.reset(); };
  const mutation = useMutation({ mutationFn: () => saveProviderSettings({ ...draft, ...(draft.composioApiKey ? { composioApiKey: draft.composioApiKey } : {}) }), onSuccess: async () => { setDraft((value) => ({ ...value, composioApiKey: "" })); setNotice("Settings saved."); await settings.refetch(); } });
  const test = useMutation({ mutationFn: () => testProviderKey(draft.composioApiKey.trim() || undefined), onSuccess: () => setNotice(draft.composioApiKey.trim() ? "Composio accepted this key. Save to start using it." : "Composio accepted the saved key.") });
  const remove = useMutation({ mutationFn: removeProviderKey, onSuccess: async () => { setConfirmRemove(false); setNotice("API key removed."); await settings.refetch(); } });
  if (settings.isLoading) return <p className="muted">Loading provider settings…</p>;
  if (settings.error) return <StatePanel error={settings.error} onRetry={() => void settings.refetch()} />;
  const key = settings.data!.status.composioApiKey;
  const busy = mutation.isPending || test.isPending || remove.isPending;
  const failure = mutation.error ?? test.error ?? remove.error;
  return <form className="settings-stack" onSubmit={(event) => { event.preventDefault(); resetFeedback(); mutation.mutate(); }}>
    <div className="settings-intro"><div><h3>Composio</h3><p>Connect Composio so you can install and run its connectors. Your API key is stored on the server and is never shown again after you save it.</p></div><Tag tone={key.configured ? "success" : "warning"}>{key.configured ? "Key saved" : "Not set up"}</Tag></div>
    <div className="credential-proof" data-testid="composio-key-status"><ShieldCheck size={18} /><div>{key.configured ? <><strong>API key ending in …{key.keyTail}</strong><p>{keySourceCopy(key.source) ? `Key ${keySourceCopy(key.source)}. ` : ""}Use “Test key” to check that Composio still accepts it.</p></> : <><strong>No API key yet</strong><p>Paste your Composio API key below, then save. You can find it in your Composio dashboard under API keys.</p></>}</div></div>
    <label>{key.configured ? "Replace API key" : "API key"}<input type="password" autoComplete="off" value={draft.composioApiKey} onChange={(event) => { resetFeedback(); setDraft((value) => ({ ...value, composioApiKey: event.target.value })); }} placeholder={key.configured ? "Leave blank to keep the current key" : "Paste your Composio API key"} /></label>
    <details className="technical-details"><summary>Advanced</summary><div className="settings-stack"><div className="form-grid two"><label>API address<input type="url" value={draft.composioBaseUrl} onChange={(event) => setDraft((value) => ({ ...value, composioBaseUrl: event.target.value }))} required /></label><label>Default user ID<input value={draft.composioDefaultUserId} onChange={(event) => setDraft((value) => ({ ...value, composioDefaultUserId: event.target.value }))} required /></label></div><label>Connected account override<input value={draft.composioDefaultConnectedAccountId} onChange={(event) => setDraft((value) => ({ ...value, composioDefaultConnectedAccountId: event.target.value }))} placeholder="Optional" /></label>{key.fingerprint && <p className="muted-detail">Key fingerprint <code>{key.fingerprint}</code></p>}</div></details>
    {failure && <InlineError error={failure} />}
    {notice && !failure && <p className="inline-success" role="status"><Check size={14} />{notice}</p>}
    <div className="dialog-actions settings-actions">
      <Button tone="primary" type="submit" disabled={busy}>{mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}Save</Button>
      <Button type="button" disabled={busy || (!key.configured && !draft.composioApiKey.trim())} onClick={() => { resetFeedback(); test.mutate(); }}>{test.isPending ? <LoaderCircle className="spin" size={15} /> : <PlugZap size={15} />}{draft.composioApiKey.trim() ? "Test new key" : "Test key"}</Button>
      {key.source === "program" && (confirmRemove ? <><Button type="button" tone="danger" disabled={busy} onClick={() => { resetFeedback(); remove.mutate(); }}>{remove.isPending ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}Confirm removal</Button><Button type="button" disabled={busy} onClick={() => setConfirmRemove(false)}>Keep key</Button></> : <Button type="button" disabled={busy} onClick={() => { resetFeedback(); setConfirmRemove(true); }}><Trash2 size={15} />Remove key</Button>)}
    </div>
    {confirmRemove && <p className="muted-detail">Removing the key stops Composio connectors from working until a new key is saved.</p>}
  </form>;
}

function DeveloperPanel() {
  const contract = useQuery({ queryKey: ["openapi"], queryFn: getOpenApi, retry: false });
  const [raw, setRaw] = useState(false);
  const operations = useMemo(() => {
    const paths = (contract.data?.paths ?? {}) as Record<string, Record<string, { summary?: string; tags?: string[] }>>;
    return Object.entries(paths).flatMap(([route, methods]) => Object.entries(methods).filter(([method]) => ["get", "post", "put", "patch", "delete"].includes(method)).map(([method, operation]) => ({ route, method, ...operation })));
  }, [contract.data]);
  if (contract.isLoading) return <p className="muted">Loading OpenAPI contract…</p>;
  if (contract.error) return <StatePanel error={contract.error} onRetry={() => void contract.refetch()} />;
  return <div className="settings-stack"><div className="settings-intro"><div><h3>Developer contract</h3><p>The Marketplace API for developers and integrations.{contract.data && typeof (contract.data.info as { version?: unknown } | undefined)?.version === "string" ? ` Version ${(contract.data.info as { version: string }).version}.` : ""}</p></div><div className="dialog-actions"><Button size="small" onClick={() => setRaw((value) => !value)}><Code2 size={14} />{raw ? "Operations" : "Raw JSON"}</Button><Button size="small" onClick={() => navigator.clipboard.writeText(JSON.stringify(contract.data, null, 2))}><Copy size={14} />Copy</Button><a className="dg-button dg-button--small" href="/openapi.json" download>Download</a></div></div>{raw ? <pre className="code-view">{JSON.stringify(contract.data, null, 2)}</pre> : <div className="operations-list">{operations.map((operation) => <div key={`${operation.method}-${operation.route}`}><code className={`method method--${operation.method}`}>{operation.method}</code><code>{operation.route}</code><span>{operation.summary}</span></div>)}</div>}</div>;
}

const LIMITATION_COPY: Record<string, string> = {
  browserEnableDisable: "Turning plugins on or off is managed from Teal Brick Portal.",
  browserMcpCrud: "Custom connectors added here must be HTTPS MCP servers. Servers that run as a local command are set up from Teal Brick Portal.",
  runtimeAdapterExecution: "Composio connectors and your custom MCP connectors can run actions. Other sources are listed for reference.",
};

export type HealthSnapshot = { online: boolean | null; approval?: ApprovalStatus };

const TAG_FOR_TONE = { success: "success", warning: "warning", danger: "danger", neutral: "default" } as const;

function AuthorizationPanel({ bootstrap, health }: { bootstrap: FrontendBootstrap; health: HealthSnapshot }) {
  const gaps = Object.entries(bootstrap.contractGaps);
  const owner = health.approval === "owner";
  return <div className="settings-stack">
    <div className="settings-intro"><div><h3>Who can change what</h3><p>{owner ? OWNER_APPROVAL_DETAIL : "Every change made here is checked against your organization's approval rules before it takes effect."}</p></div><ShieldCheck /></div>
    <dl className="contract-list" aria-label="Service status"><dt>Marketplace</dt><dd><Tag tone={health.online === false ? "danger" : health.online ? "success" : "default"}>{health.online === false ? "Offline" : health.online ? "Online" : "Checking…"}</Tag></dd><dt>Approvals (Rules)</dt><dd><Tag tone={health.approval ? TAG_FOR_TONE[APPROVAL_STATUS_COPY[health.approval].tone] : "default"}>{health.approval ? APPROVAL_STATUS_COPY[health.approval].label : "Checking…"}</Tag>{health.approval && <p className="muted-detail">{APPROVAL_STATUS_COPY[health.approval].detail}</p>}</dd></dl>
    <dl className="contract-list"><dt>Your browser session</dt><dd>Browse the catalog and request installs, connections, and agent access</dd><dt>Approvals</dt><dd>{owner ? "You approve each change yourself while signed in. Agents and other apps can only act with consent you grant in Teal Brick Portal." : "Your organization's rules approve or block each change. If approvals can't be checked, nothing is changed."}</dd><dt>Agents and other apps</dt><dd>Use a separate service credential that is never shared with this browser</dd><dt>Provider keys</dt><dd>Kept on the server and never sent to your browser</dd></dl>
    {gaps.length > 0 && <div className="contract-gap"><AlertTriangle size={17} /><div><strong>Not available in this browser yet</strong><ul className="plain-list">{gaps.map(([name]) => <li key={name}>{LIMITATION_COPY[name] ?? "Some management actions are only available from Teal Brick Portal."}</li>)}</ul></div></div>}
    <details className="technical-details"><summary>Technical details</summary><dl className="contract-list"><dt>Browser routes</dt><dd><code>{bootstrap.authorization.browserOperatorRoutes}</code></dd><dt>Hub service</dt><dd>Internal bearer required</dd><dt>Cross-app broker v1</dt><dd>Internal bearer required</dd><dt>Credential in browser</dt><dd>{bootstrap.authorization.credentialExposedToBrowser ? "Yes" : "No"}</dd>{gaps.map(([name, state]) => <Fragment key={name}><dt>{name}</dt><dd><code>{state}</code></dd></Fragment>)}</dl></details>
  </div>;
}

function SecurityPanel({ session, onLogout }: { session: OperatorSession; onLogout: () => void }) {
  const logout = useMutation({ mutationFn: logoutOperator, onSuccess: onLogout });
  return <div className="settings-stack"><div className="settings-intro"><div><h3>Your session</h3><p>You're signed in to Marketplace in this browser. Agents and other apps use their own separate credentials.</p></div><ShieldCheck /></div><dl className="contract-list"><dt>Signed in as</dt><dd>{session.principal?.id ?? "—"}</dd><dt>Organization</dt><dd>{session.principal?.organizationId ?? "—"}</dd><dt>Session ends</dt><dd>{session.expiresAt ? new Date(session.expiresAt).toLocaleString() : session.mode === "test_bypass" ? "Test mode" : "—"}</dd><dt>Sign-in</dt><dd>Secure browser cookie; your access token isn't stored</dd><dt>Change protection</dt><dd>Each change is verified as coming from this session</dd></dl>{logout.error && <InlineError error={logout.error} />}<div><Button tone="danger" disabled={logout.isPending} onClick={() => logout.mutate()}><LogOut size={15} />Sign out</Button></div></div>;
}

export function SettingsDialog({ open, onOpenChange, bootstrap, workspaceSlug, session, onLogout, health }: { health: HealthSnapshot; open: boolean; onOpenChange: (open: boolean) => void; bootstrap: FrontendBootstrap; workspaceSlug: string; session: OperatorSession; onLogout: () => void }) {
  const capabilities = useQuery({ queryKey: ["agent-capabilities", workspaceSlug], queryFn: () => getAgentCapabilities(workspaceSlug), enabled: open, retry: false });
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="settings-dialog"><header className="modal-header"><div><p className="eyebrow">Marketplace</p><Dialog.Title>Settings</Dialog.Title><Dialog.Description>Provider keys, your session, permissions, and agent tools.</Dialog.Description></div><Dialog.Close asChild><IconButton aria-label="Close settings"><X size={17} /></IconButton></Dialog.Close></header><Tabs.Root className="settings-tabs" defaultValue="providers"><Tabs.List aria-label="Marketplace settings"><Tabs.Trigger value="providers"><Plug size={15} />Providers</Tabs.Trigger><Tabs.Trigger value="security"><ShieldCheck size={15} />Security</Tabs.Trigger><Tabs.Trigger value="authorization"><ShieldCheck size={15} />Authorization</Tabs.Trigger><Tabs.Trigger value="agent"><TerminalSquare size={15} />Agent tools</Tabs.Trigger><Tabs.Trigger value="developer"><Code2 size={15} />Developer</Tabs.Trigger></Tabs.List><div className="settings-content"><Tabs.Content value="providers"><ProviderSettingsPanel /></Tabs.Content><Tabs.Content value="security"><SecurityPanel session={session} onLogout={onLogout} /></Tabs.Content><Tabs.Content value="authorization"><AuthorizationPanel bootstrap={bootstrap} health={health} /></Tabs.Content><Tabs.Content value="agent"><div className="settings-stack"><div className="settings-intro"><div><h3>Agent tools</h3><p>Agents can only use tools that are installed, connected, and switched on.</p></div><Tag tone="accent">{capabilities.data?.capabilities.length ?? 0} tools</Tag></div>{capabilities.error ? <StatePanel error={capabilities.error} onRetry={() => void capabilities.refetch()} /> : <pre className="code-view">{capabilities.isLoading ? "Loading agent tools…" : JSON.stringify(capabilities.data, null, 2)}</pre>}</div></Tabs.Content><Tabs.Content value="developer"><DeveloperPanel /></Tabs.Content></div></Tabs.Root></Dialog.Content></Dialog.Portal></Dialog.Root>;
}
