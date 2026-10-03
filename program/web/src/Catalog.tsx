import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  Boxes,
  Check,
  ChevronRight,
  CircleDot,
  Download,
  ExternalLink,
  Link2,
  LoaderCircle,
  PackageCheck,
  PackageMinus,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare,
  Unplug,
  X,
} from "lucide-react";
import { Button, IconButton, Tag } from "@doppelganger/ui";

import {
  bindAction,
  connectPlugin,
  executeAction,
  installPlugin,
  registerPlugin,
  uninstallPlugin,
  unregisterPlugin,
} from "./api";
import type { PluginCard, PluginSummary } from "./types";
import { errorCopy, formatWhen, statusTone, words } from "./ui";

export type ConfirmState = {
  title: string;
  detail: string;
  label: string;
  danger?: boolean;
  run: () => Promise<unknown>;
} | null;

export function CatalogRow({ card, selected, onSelect }: { card: PluginSummary; selected: boolean; onSelect: () => void }) {
  return (
    <button className="catalog-row" aria-current={selected} onClick={onSelect}>
      <span className="catalog-monogram">{card.displayName.slice(0, 2).toUpperCase()}</span>
      <span className="catalog-row__body">
        <span className="catalog-row__title"><strong>{card.displayName}</strong>{card.install && <span className="installed-mark"><Check size={11} /></span>}</span>
        <span>{card.description || card.sourceLabel}</span>
        <span className="catalog-row__meta"><Tag>{card.source}</Tag><Tag tone={statusTone(card.status)}>{words(card.status)}</Tag></span>
      </span>
      <ChevronRight size={15} />
    </button>
  );
}

export function ConfirmDialog({ state, onClose, onSuccess }: { state: ConfirmState; onClose: () => void; onSuccess: (result: unknown) => void }) {
  const mutation = useMutation({ mutationFn: async () => state!.run(), onSuccess: (result) => { onSuccess(result); onClose(); } });
  useEffect(() => { mutation.reset(); }, [state]);
  return (
    <Dialog.Root open={Boolean(state)} onOpenChange={(open) => { if (!open && !mutation.isPending) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="confirm-dialog">
          <Dialog.Title>{state?.title}</Dialog.Title>
          <Dialog.Description>{state?.detail}</Dialog.Description>
          {mutation.error && <p className="inline-error"><AlertTriangle size={14} />{errorCopy(mutation.error).detail}</p>}
          <div className="dialog-actions"><Button onClick={onClose} disabled={mutation.isPending}>Cancel</Button><Button tone={state?.danger ? "danger" : "primary"} onClick={() => mutation.mutate()} disabled={mutation.isPending}>{mutation.isPending ? <LoaderCircle className="spin" size={15} /> : state?.danger ? <PackageMinus size={15} /> : <Check size={15} />}{state?.label}</Button></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ConnectDialog({ card, workspaceSlug, open, onOpenChange, onConnected }: { card: PluginCard; workspaceSlug: string; open: boolean; onOpenChange: (open: boolean) => void; onConnected: () => void }) {
  const backend: "composio" | "native" = card.listing.source === "composio" ? "composio" : "native";
  const authorizationWindow = useRef<Window | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const closeAuthorizationWindow = () => {
    if (authorizationWindow.current && !authorizationWindow.current.closed) {
      authorizationWindow.current.close();
    }
    authorizationWindow.current = null;
  };
  const mutation = useMutation({
    mutationFn: () => connectPlugin(card.listing.pluginId, workspaceSlug, card.listing.provider, backend),
    onSuccess: (result) => {
      if (result.auth?.redirectUrl) {
        if (authorizationWindow.current && !authorizationWindow.current.closed) {
          authorizationWindow.current.location.replace(result.auth.redirectUrl);
        } else {
          setPopupBlocked(true);
        }
      } else {
        closeAuthorizationWindow();
      }
      onConnected();
    },
    onError: closeAuthorizationWindow,
  });
  const startConnection = () => {
    setPopupBlocked(false);
    authorizationWindow.current = window.open("about:blank", "marketplace-oauth", "popup,width=620,height=760");
    mutation.mutate();
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="form-dialog">
        <header className="modal-header"><div><p className="eyebrow">Provider connection</p><Dialog.Title>Connect {card.addon.displayName}</Dialog.Title><Dialog.Description>{backend === "composio" ? "Marketplace will request a Composio authorization link. OAuth material remains with Composio; the Program stores only connection references." : "This native adapter records a local connection reference. No raw secret is collected in this dialog."}</Dialog.Description></div><Dialog.Close asChild><IconButton aria-label="Close connection dialog"><X size={17} /></IconButton></Dialog.Close></header>
        <div className="modal-body">
          <dl className="contract-list"><dt>Backend</dt><dd>{backend}</dd><dt>Provider</dt><dd>{card.listing.provider}</dd><dt>Current state</dt><dd>{card.connection?.state ?? "disconnected"}</dd><dt>External impact</dt><dd>{backend === "composio" ? "Opens provider authorization; no grant is completed until you approve there." : "Registers a native Program connection."}</dd></dl>
          {mutation.error && <p className="inline-error"><AlertTriangle size={14} />{errorCopy(mutation.error).detail}</p>}
          {popupBlocked && <p className="inline-error"><AlertTriangle size={14} />The authorization window was blocked. Allow popups for Marketplace, then retry the connection.</p>}
        </div>
        <footer className="modal-footer"><span>Rules evaluates connector administration before the Program records it.</span><div className="dialog-actions"><Dialog.Close asChild><Button>Cancel</Button></Dialog.Close><Button tone="primary" disabled={mutation.isPending} onClick={startConnection}>{mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <ExternalLink size={15} />}Start connection</Button></div></footer>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  );
}

function ExecuteDialog({ card, workspaceSlug, open, onOpenChange }: { card: PluginCard; workspaceSlug: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const actions = card.toolSelection.actions.filter((action) => action.enabled);
  const [actionKey, setActionKey] = useState(actions[0]?.actionKey ?? "");
  const [argumentsJson, setArgumentsJson] = useState("{}");
  const [reviewed, setReviewed] = useState(false);
  const selected = actions.find((action) => action.actionKey === actionKey);
  const mutation = useMutation({ mutationFn: () => {
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
    return executeAction(card.listing.pluginId, workspaceSlug, selected!.capability, { ...parsed, type: selected!.actionKey });
  }});
  useEffect(() => { setActionKey(actions[0]?.actionKey ?? ""); setArgumentsJson("{}"); setReviewed(false); mutation.reset(); }, [card.listing.pluginId, open]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="form-dialog execution-dialog">
      <header className="modal-header"><div><p className="eyebrow">Governed external action</p><Dialog.Title>Execute {card.addon.displayName}</Dialog.Title><Dialog.Description>Execution may read or change external provider data. Inspect the selected operation and arguments before confirming.</Dialog.Description></div><Dialog.Close asChild><IconButton aria-label="Close execution dialog"><X size={17} /></IconButton></Dialog.Close></header>
      <div className="modal-body execution-form">
        {!actions.length ? <div className="contract-gap"><AlertTriangle /><div><strong>No enabled actions</strong><p>Install and connect the plugin, then enable at least one tool before execution.</p></div></div> : <>
          <label>Action<select value={actionKey} onChange={(event) => { setActionKey(event.target.value); setReviewed(false); }}>{actions.map((action) => <option key={action.actionKey} value={action.actionKey}>{action.displayName}</option>)}</select></label>
          <label>Arguments JSON<textarea className="mono" rows={8} value={argumentsJson} onChange={(event) => { setArgumentsJson(event.target.value); setReviewed(false); }} spellCheck={false} /></label>
          <div className="execution-review"><ShieldCheck size={18} /><div><strong>{selected?.capability}</strong><p>{selected?.description || "The provider owns the action semantics and result."}</p></div></div>
          <label className="confirm-check"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />I reviewed this external action and its arguments.</label>
        </>}
        {mutation.error && <p className="inline-error"><AlertTriangle size={14} />{mutation.error instanceof SyntaxError ? "Arguments must be valid JSON." : errorCopy(mutation.error).detail}</p>}
        {mutation.data && <pre className="result-view">{JSON.stringify(mutation.data, null, 2)}</pre>}
      </div>
      <footer className="modal-footer"><span>The Program verifies install, connection, bindings, and Rules before dispatch.</span><div className="dialog-actions"><Dialog.Close asChild><Button>Close</Button></Dialog.Close><Button tone="primary" disabled={!selected || !reviewed || mutation.isPending} onClick={() => mutation.mutate()}>{mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <TerminalSquare size={15} />}Execute action</Button></div></footer>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  );
}

export function PluginWorkspace({ card, loading, workspaceSlug, onConfirm, onRefresh }: { card: PluginCard | null; loading: boolean; workspaceSlug: string; onConfirm: (state: NonNullable<ConfirmState>) => void; onRefresh: () => void }) {
  const [connectOpen, setConnectOpen] = useState(false);
  const [executeOpen, setExecuteOpen] = useState(false);
  const queryClient = useQueryClient();
  const binding = useMutation({ mutationFn: ({ actionKey, enabled }: { actionKey: string; enabled: boolean }) => bindAction(card!.listing.pluginId, workspaceSlug, actionKey, enabled), onSuccess: onRefresh });
  if (loading) return <div className="detail-empty"><LoaderCircle className="spin" size={28} /><h2>Loading capability detail</h2><p>The full manifest and tool contract are fetched only for this selection.</p></div>;
  if (!card) return <div className="detail-empty"><Boxes size={28} /><h2>Select a capability</h2><p>Inspect its source, lifecycle plan, connection state, and Agent tool contract.</p></div>;
  const pluginId = card.listing.pluginId;
  const installed = card.install?.lifecycle === "installed";
  const launchSupported = card.listing.executionOwner === "composio";
  const required = Boolean((card.listing.manifest as { required?: boolean }).required);
  const confirmLifecycle = (action: "install" | "uninstall" | "register" | "unregister") => {
    const run = action === "install" ? () => installPlugin(pluginId, workspaceSlug) : action === "uninstall" ? () => uninstallPlugin(pluginId, workspaceSlug) : action === "register" ? () => registerPlugin(pluginId, workspaceSlug) : () => unregisterPlugin(pluginId, workspaceSlug);
    onConfirm({ title: `${words(action)} ${card.addon.displayName}?`, detail: action === "install" ? "Rules will evaluate connector administration, then Marketplace will record the workspace install." : action === "uninstall" ? "This removes the workspace install and disconnects its Agent projection. Provider-owned external accounts are not deleted." : `${words(action)} changes the plugin runtime registry after Rules approval.`, label: words(action), danger: action === "uninstall" || action === "unregister", run });
  };
  return (
    <article className="plugin-workspace">
      <header className="plugin-header">
        <div className="plugin-identity"><span className="plugin-monogram">{card.addon.displayName.slice(0, 2).toUpperCase()}</span><div><p className="eyebrow">{card.marketplaceName} · {card.runtimeSource}</p><h1>{card.addon.displayName}</h1><code>{pluginId}</code></div></div>
        <div className="plugin-status"><Tag tone={statusTone(card.state.status)}>{words(card.state.status)}</Tag><span>Refreshed {formatWhen(card.state.refreshedAt)}</span></div>
      </header>
      <p className="plugin-lede">{card.description || "No catalog description was provided."}</p>
      <div className="action-bar">
        {!installed ? <Button tone="primary" disabled={!launchSupported} onClick={() => confirmLifecycle("install")}><Download size={15} />Install</Button> : <Button tone="danger" disabled={required} onClick={() => confirmLifecycle("uninstall")}><PackageMinus size={15} />Uninstall</Button>}
        {!card.state.registered ? <Button disabled={!launchSupported} onClick={() => confirmLifecycle("register")}><PackageCheck size={15} />Register</Button> : <Button disabled={required} onClick={() => confirmLifecycle("unregister")}><Unplug size={15} />Unregister</Button>}
        <Button disabled={!installed || !launchSupported} onClick={() => setConnectOpen(true)}><Link2 size={15} />{card.connection ? "Reconnect" : "Connect"}</Button>
        <Button disabled={!card.state.ready || !launchSupported} onClick={() => setExecuteOpen(true)}><TerminalSquare size={15} />Execute</Button>
      </div>
      {!launchSupported && <div className="contract-gap"><AlertTriangle size={17} /><div><strong>Catalog-only in this launch profile</strong><p>Only Composio-backed connectors can be installed, connected, projected to Agents, or executed. {words(card.listing.executionOwner)} remains visible for roadmap inspection and is never simulated as success.</p></div></div>}
      {!card.state.ready && <div className="readiness-note"><AlertTriangle size={17} /><div><strong>Not ready for Agent execution</strong><p>{card.connection?.detail || card.installPlan.steps.find((step) => step.status !== "complete")?.detail || "Complete the lifecycle and connection steps below."}</p></div></div>}
      <div className="detail-grid">
        <section><div className="section-heading"><div><p className="eyebrow">Lifecycle</p><h2>Activation plan</h2></div><span>{card.installPlan.steps.filter((step) => step.status === "complete").length}/{card.installPlan.steps.length}</span></div><ol className="install-plan">{card.installPlan.steps.map((step) => <li key={step.kind} className={step.status === "complete" ? "is-complete" : ""}><span>{step.status === "complete" ? <Check size={13} /> : <CircleDot size={13} />}</span><div><strong>{step.label}</strong><p>{step.detail}</p></div></li>)}</ol></section>
        <section><div className="section-heading"><div><p className="eyebrow">Runtime</p><h2>Authority & source</h2></div><SlidersHorizontal size={18} /></div><dl className="fact-list"><dt>Source</dt><dd>{card.sourceLabel}</dd><dt>Execution owner</dt><dd>{card.listing.executionOwner}</dd><dt>Auth owner</dt><dd>{card.listing.authOwner}</dd><dt>Connection</dt><dd><Tag tone={statusTone(card.connection?.state ?? "disconnected")}>{words(card.connection?.state ?? "disconnected")}</Tag></dd><dt>Version</dt><dd className="mono">{card.addon.version}</dd></dl></section>
      </div>
      <section className="tool-contract">
        <div className="section-heading"><div><p className="eyebrow">Agent projection</p><h2>Tools & bindings</h2></div><Tag>{card.toolSelection.enabled}/{card.toolSelection.total} enabled</Tag></div>
        <p className="section-copy">{launchSupported ? "Tool selection is independent of provider authorization. Disabled actions remain absent from Agent capability discovery." : "These declared actions are catalog evidence only and remain absent from Agent capability discovery until a real execution backend is supported."}</p>
        {card.toolSelection.actions.length ? <div className="tool-list">{card.toolSelection.actions.slice(0, 40).map((action) => <div key={action.actionKey}><div><strong>{action.displayName}</strong><code>{action.actionKey}</code><p>{action.description}</p></div><Tag>{action.capability.replace("connector.", "")}</Tag><Button size="small" disabled={!launchSupported || !installed || binding.isPending} onClick={() => binding.mutate({ actionKey: action.actionKey, enabled: !action.enabled })}>{action.enabled ? "Exclude" : "Include"}</Button></div>)}</div> : <div className="collection-empty compact"><SlidersHorizontal /><h3>No selectable tools</h3><p>This catalog record does not expose action-level bindings.</p></div>}
        {card.toolSelection.actions.length > 40 && <p className="muted-row">Showing 40 of {card.toolSelection.actions.length} actions. Use the API contract for bulk inspection.</p>}
        {binding.error && <p className="inline-error"><AlertTriangle size={14} />{errorCopy(binding.error).detail}</p>}
      </section>
      <section className="contract-gap"><ShieldCheck size={18} /><div><strong>Hub-only lifecycle stays isolated</strong><p>Enable, disable, reload, and custom MCP configuration require the internal Host SDK bearer boundary. Marketplace does not expose that credential to this browser.</p></div></section>
      <ConnectDialog card={card} workspaceSlug={workspaceSlug} open={connectOpen} onOpenChange={setConnectOpen} onConnected={() => { void queryClient.invalidateQueries({ queryKey: ["cards"] }); }} />
      <ExecuteDialog card={card} workspaceSlug={workspaceSlug} open={executeOpen} onOpenChange={setExecuteOpen} />
    </article>
  );
}
