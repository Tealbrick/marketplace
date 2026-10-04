import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, Check, KeyRound, LoaderCircle, Pencil, Plus, RefreshCw, Server, ShieldCheck, Trash2, Undo2, X } from "lucide-react";
import { Button, IconButton, Tag } from "@tealbrick/ui";

import { createCustomConnector, deleteCustomConnector, getCustomConnectors, refreshCustomConnector, updateCustomConnector } from "./api";
import { refreshErrorCopy } from "./copy";
import type { ConnectorCapabilityName, CustomConnector, CustomConnectorCreate, CustomConnectorPatch } from "./types";
import { formatWhen, InlineError, StatePanel, statusLabel, statusTone } from "./ui";

const CAPABILITY_COPY: Record<ConnectorCapabilityName, { label: string; tone: "success" | "accent" | "warning" }> = {
  "connector.observe": { label: "Read only", tone: "success" },
  "connector.dispatch": { label: "Makes changes", tone: "accent" },
  "connector.admin": { label: "Admin / destructive", tone: "warning" },
};

const TRANSPORT_LABEL: Record<CustomConnector["transport"], string> = {
  "streamable-http": "Streamable HTTP",
  sse: "Server-Sent Events (legacy)",
};

type HeaderRow = {
  key: number;
  name: string;
  value: string;
  secret: boolean;
  /** Saved secret this row represents (edit mode). */
  saved?: { fingerprint: string; originalName: string };
  /** Saved secrets: keep, replace with `value`, or remove. */
  mode: "keep" | "replace" | "remove" | "new";
};

let rowKey = 0;
const nextKey = () => (rowKey += 1);

function rowsFor(connector: CustomConnector | null): HeaderRow[] {
  if (!connector) return [];
  return [
    ...connector.headers.map((header) => ({ key: nextKey(), name: header.name, value: header.value, secret: false, mode: "new" as const })),
    ...connector.secretHeaders.map((header) => ({ key: nextKey(), name: header.name, value: "", secret: true, saved: { fingerprint: header.fingerprint, originalName: header.name }, mode: "keep" as const })),
  ];
}

function ConnectorDialog({ connector, open, onOpenChange, secretStoreAvailable, onSaved }: { connector: CustomConnector | null; open: boolean; onOpenChange: (open: boolean) => void; secretStoreAvailable: boolean; onSaved: (connector: CustomConnector, created: boolean) => void }) {
  const editing = connector !== null;
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState<CustomConnector["transport"]>("streamable-http");
  const [rows, setRows] = useState<HeaderRow[]>([]);
  const updateRow = (key: number, patch: Partial<HeaderRow>) => setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const mutation = useMutation({
    mutationFn: async () => {
      const headers: Record<string, string> = {};
      const secretHeaders: Record<string, string | null> = {};
      for (const row of rows) {
        const name = row.name.trim();
        if (row.saved) {
          if (row.mode === "remove") secretHeaders[row.saved.originalName] = null;
          if (row.mode === "replace" && row.value) secretHeaders[row.saved.originalName] = row.value;
          continue;
        }
        if (!name) continue;
        if (row.secret) secretHeaders[name] = row.value;
        else headers[name] = row.value;
      }
      if (!editing) {
        const input: CustomConnectorCreate = {
          displayName: displayName.trim(),
          url: url.trim(),
          transport,
          ...(description.trim() ? { description: description.trim() } : {}),
          headers,
          secretHeaders: secretHeaders as Record<string, string>,
        };
        return { connector: (await createCustomConnector(input)).connector, created: true };
      }
      const patch: CustomConnectorPatch = {
        displayName: displayName.trim(),
        description: description.trim(),
        headers,
        ...(Object.keys(secretHeaders).length ? { secretHeaders } : {}),
        // The form shows origin + path only; send the address back only when
        // it was edited so a saved query string is never dropped by accident.
        ...(url.trim() !== connector.url ? { url: url.trim() } : {}),
        ...(transport !== connector.transport ? { transport } : {}),
      };
      return { connector: (await updateCustomConnector(connector.pluginId, patch)).connector, created: false };
    },
    onSuccess: (result) => onSaved(result.connector, result.created),
  });
  useEffect(() => {
    if (!open) return;
    setDisplayName(connector?.displayName ?? "");
    setDescription(connector?.description ?? "");
    setUrl(connector?.url ?? "");
    setTransport(connector?.transport ?? "streamable-http");
    setRows(rowsFor(connector));
    mutation.reset();
  }, [open, connector?.pluginId]);
  const addingSecret = rows.some((row) => row.secret && (row.mode === "new" || row.mode === "replace"));
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!mutation.isPending) onOpenChange(next); }}>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="form-dialog custom-connector-dialog">
      <header className="modal-header"><div><p className="eyebrow">Custom connector</p><Dialog.Title>{editing ? `Edit ${connector.displayName}` : "Add an MCP server"}</Dialog.Title><Dialog.Description>Connect a remote MCP server so agents can use its tools. Only https:// servers are supported; local commands can't be added here.</Dialog.Description></div><Dialog.Close asChild><IconButton aria-label="Close connector dialog"><X size={17} /></IconButton></Dialog.Close></header>
      <form id="custom-connector-form" className="modal-body settings-stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
        <div className="form-grid two">
          <label>Name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} required placeholder="Issue tracker" /></label>
          <label>Connection type<select value={transport} onChange={(event) => setTransport(event.target.value as CustomConnector["transport"])}><option value="streamable-http">Streamable HTTP (recommended)</option><option value="sse">Server-Sent Events (legacy)</option></select></label>
        </div>
        <label>Server URL<input type="url" value={url} onChange={(event) => setUrl(event.target.value)} required placeholder="https://mcp.example.com/mcp" inputMode="url" autoComplete="off" /></label>
        <p className="muted-detail field-help">Must start with https://. Addresses on your Tailscale network (*.ts.net) work. Local, private-network, and cloud metadata addresses are blocked.{editing ? " Changing the address or connection type disconnects the connector until you refresh its tools." : ""}</p>
        <label>Description<input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} placeholder="Optional" /></label>
        <fieldset className="header-rows">
          <legend>Headers</legend>
          <p className="muted-detail">Sent with every request to this server. Mark API keys and tokens as secret: secret values are encrypted on the server and never shown again.</p>
          {rows.length === 0 && <p className="muted-detail">No headers.</p>}
          {rows.map((row, index) => row.saved ? <div className={`header-row header-row--saved${row.mode === "remove" ? " is-removed" : ""}`} key={row.key}>
            <code>{row.saved.originalName}</code>
            {row.mode === "replace" ? <input aria-label={`New value for ${row.saved.originalName}`} type="password" autoComplete="new-password" value={row.value} onChange={(event) => updateRow(row.key, { value: event.target.value })} placeholder="New secret value" required /> : <span className="header-row__saved"><KeyRound size={13} />{row.mode === "remove" ? "Will be removed" : <>Saved · <code>{row.saved.fingerprint}</code></>}</span>}
            <div className="dialog-actions">{row.mode === "keep" ? <><Button size="small" type="button" onClick={() => updateRow(row.key, { mode: "replace", value: "" })}>Replace</Button><Button size="small" type="button" onClick={() => updateRow(row.key, { mode: "remove" })}>Remove</Button></> : <Button size="small" type="button" onClick={() => updateRow(row.key, { mode: "keep", value: "" })}><Undo2 size={13} />Undo</Button>}</div>
          </div> : <div className="header-row" key={row.key}>
            <input aria-label={`Header name ${index + 1}`} value={row.name} onChange={(event) => updateRow(row.key, { name: event.target.value })} placeholder="X-Api-Key" autoComplete="off" />
            <input aria-label={`Header value ${index + 1}`} type={row.secret ? "password" : "text"} autoComplete={row.secret ? "new-password" : "off"} value={row.value} onChange={(event) => updateRow(row.key, { value: event.target.value })} placeholder={row.secret ? "Secret value" : "Value"} />
            <label className="confirm-check"><input type="checkbox" checked={row.secret} onChange={(event) => updateRow(row.key, { secret: event.target.checked })} aria-label={`Secret header ${index + 1}`} />Secret</label>
            <IconButton aria-label={`Remove header ${index + 1}`} type="button" onClick={() => setRows((current) => current.filter((entry) => entry.key !== row.key))}><X size={14} /></IconButton>
          </div>)}
          <div><Button size="small" type="button" onClick={() => setRows((current) => [...current, { key: nextKey(), name: "", value: "", secret: false, mode: "new" }])}><Plus size={13} />Add header</Button></div>
        </fieldset>
        {addingSecret && !secretStoreAvailable && <p className="inline-error"><AlertTriangle size={14} /><span>Secret storage isn't set up on this Marketplace, so secret headers can't be saved.</span></p>}
        {mutation.error && <InlineError error={mutation.error} />}
      </form>
      <footer className="modal-footer"><span>Your organization's approval rules are checked before anything is saved.</span><div className="dialog-actions"><Dialog.Close asChild><Button type="button" disabled={mutation.isPending}>Cancel</Button></Dialog.Close><Button tone="primary" type="submit" form="custom-connector-form" disabled={mutation.isPending}>{mutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{editing ? "Save changes" : "Add connector"}</Button></div></footer>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}

function ConnectorCard({ connector, onEdit, onChanged }: { connector: CustomConnector; onEdit: () => void; onChanged: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refresh = useMutation({ mutationFn: () => refreshCustomConnector(connector.pluginId), onSettled: onChanged });
  const remove = useMutation({ mutationFn: () => deleteCustomConnector(connector.pluginId), onSuccess: onChanged });
  const busy = refresh.isPending || remove.isPending;
  const state = connector.connection?.state ?? "disconnected";
  const lastError = connector.lastRefresh && !connector.lastRefresh.ok && connector.lastRefresh.errorCode ? refreshErrorCopy(connector.lastRefresh.errorCode) : null;
  return <article className="custom-connector" aria-label={connector.displayName}>
    <header>
      <span className="catalog-monogram">{connector.displayName.slice(0, 2).toUpperCase()}</span>
      <div><strong>{connector.displayName}</strong><code>{connector.url}</code>{connector.description && <p>{connector.description}</p>}</div>
      <div className="custom-connector__tags"><Tag tone={statusTone(state)}>{statusLabel(state)}</Tag><Tag>{TRANSPORT_LABEL[connector.transport]}</Tag>{connector.install.installed && <Tag tone="success">Installed</Tag>}</div>
    </header>
    <dl className="fact-list custom-connector__facts">
      <dt>Headers</dt><dd>{[...connector.headers.map((header) => header.name), ...connector.secretHeaders.map((header) => `${header.name} (secret · ${header.fingerprint})`)].join(", ") || "None"}</dd>
      <dt>Tools</dt><dd>{connector.lastRefresh?.ok ? `${connector.tools.length} loaded ${formatWhen(connector.lastRefresh.at)}` : connector.tools.length ? `${connector.tools.length} (from an earlier refresh)` : "Not loaded yet"}</dd>
    </dl>
    {lastError && <p className="inline-error" role="status"><AlertTriangle size={14} /><span><strong>Last refresh failed: {lastError.title}.</strong> {lastError.detail}</span></p>}
    {!connector.lastRefresh && <p className="muted-detail">Choose Refresh tools to connect and load this server's tools. Then install the connector from the catalog so agents can use it.</p>}
    {connector.tools.length > 0 && <div className="tool-list">{connector.tools.slice(0, 40).map((tool) => <div key={tool.action}><div><strong>{tool.title ?? tool.name}</strong><code>{tool.action}</code>{tool.description && <p>{tool.description}</p>}</div><Tag tone={CAPABILITY_COPY[tool.capability].tone}>{CAPABILITY_COPY[tool.capability].label}</Tag></div>)}</div>}
    {connector.tools.length > 40 && <p className="muted-row">Showing 40 of {connector.tools.length} tools.</p>}
    {refresh.error && <InlineError error={refresh.error} />}
    {remove.error && <InlineError error={remove.error} />}
    <div className="dialog-actions custom-connector__actions">
      <Button size="small" tone="primary" disabled={busy} onClick={() => { remove.reset(); refresh.mutate(); }}>{refresh.isPending ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}Refresh tools</Button>
      <Button size="small" disabled={busy} onClick={onEdit}><Pencil size={14} />Edit</Button>
      {confirmDelete ? <><Button size="small" tone="danger" disabled={busy} onClick={() => remove.mutate()}>{remove.isPending ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}Confirm delete</Button><Button size="small" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep</Button></> : <Button size="small" disabled={busy} onClick={() => { refresh.reset(); setConfirmDelete(true); }}><Trash2 size={14} />Delete</Button>}
    </div>
    {confirmDelete && <p className="muted-detail">Deleting removes the connector, its saved secrets, and any agent access to it. This can't be undone.</p>}
  </article>;
}

export function CustomConnectorsSection({ onChanged }: { onChanged: () => void }) {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ["custom-connectors"], queryFn: getCustomConnectors, retry: false });
  const [dialog, setDialog] = useState<{ connector: CustomConnector | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const changed = () => { void queryClient.invalidateQueries({ queryKey: ["custom-connectors"] }); onChanged(); };
  const items = list.data?.items ?? [];
  return <section className="custom-connectors" aria-labelledby="custom-connectors-heading">
    <div className="section-heading"><div><p className="eyebrow">Your servers</p><h2 id="custom-connectors-heading">Custom connectors</h2></div><Button size="small" tone="primary" onClick={() => { setNotice(null); setDialog({ connector: null }); }}><Plus size={14} />Add connector</Button></div>
    <p className="section-copy">Bring your own MCP server so agents can use its tools. Servers must use an https:// address, on the public internet or your Tailscale network (*.ts.net). Local commands and private-network addresses aren't supported here.</p>
    {list.data && !list.data.secretStoreAvailable && <div className="contract-gap"><ShieldCheck size={17} /><div><strong>Secret headers are unavailable</strong><p>This Marketplace isn't set up to store secrets securely. You can still add servers that don't need an API key.</p></div></div>}
    {notice && <p className="inline-success" role="status"><Check size={14} />{notice}</p>}
    {list.error ? <StatePanel error={list.error} onRetry={() => void list.refetch()} /> : list.isLoading ? <p className="muted">Loading custom connectors…</p> : items.length ? <div className="custom-connector-list">{items.map((connector) => <ConnectorCard key={connector.pluginId} connector={connector} onEdit={() => { setNotice(null); setDialog({ connector }); }} onChanged={changed} />)}</div> : <div className="collection-empty compact"><Server /><h3>No custom connectors yet</h3><p>Add an MCP server to make its tools available to your workspace.</p></div>}
    <ConnectorDialog
      connector={dialog?.connector ?? null}
      open={dialog !== null}
      onOpenChange={(open) => { if (!open) setDialog(null); }}
      secretStoreAvailable={list.data?.secretStoreAvailable ?? true}
      onSaved={(connector, created) => { setDialog(null); setNotice(created ? `${connector.displayName} added. Refresh its tools to connect.` : `${connector.displayName} saved.`); changed(); }}
    />
  </section>;
}
