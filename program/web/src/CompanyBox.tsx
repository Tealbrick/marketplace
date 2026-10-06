import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, Boxes, Check, KeyRound, LoaderCircle, PlugZap, Send, Settings2, Trash2, Undo2, X } from "lucide-react";
import { Button, IconButton, Tag } from "@tealbrick/ui";

import { ApiError, getCompanyBox, removeCompanyBoxEntry, setupCompanyBoxEntry, testCompanyBoxEntry } from "./api";
import { errorCopy } from "./copy";
import type { CompanyBoxCredentialKey, CompanyBoxEntry, CompanyBoxResult } from "./types";
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

function SetupDialog({ entry, open, onOpenChange, secretStoreAvailable, onSaved }: { entry: CompanyBoxEntry | null; open: boolean; onOpenChange: (open: boolean) => void; secretStoreAvailable: boolean; onSaved: (result: CompanyBoxResult) => void }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [values, setValues] = useState<Partial<Record<CompanyBoxCredentialKey, string>>>({});
  const [modes, setModes] = useState<Partial<Record<CompanyBoxCredentialKey, CredentialMode>>>({});
  const mutation = useMutation({
    mutationFn: () => {
      const credentials: Partial<Record<CompanyBoxCredentialKey, string>> = {};
      for (const field of entry!.credentials) {
        const saved = field.configured && modes[field.key] !== "replace";
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
  // MCP entries send the credential fields together as one header.
  const together = entry.source === "mcp";
  const anyReplacing = entry.credentials.some((field) => !field.configured || modes[field.key] === "replace");
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!mutation.isPending) onOpenChange(next); }}>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="form-dialog custom-connector-dialog company-box-dialog">
      <header className="modal-header"><div><p className="eyebrow">Company Box</p><Dialog.Title>{entry.installed ? `Edit ${entry.displayName}` : `Set up ${entry.displayName}`}</Dialog.Title><Dialog.Description>Installs once for the workspace with its full API ({coverageLabel(entry)}). You choose which agents can use it in Agent grants.</Dialog.Description></div><Dialog.Close asChild><IconButton aria-label="Close setup dialog"><X size={17} /></IconButton></Dialog.Close></header>
      <form id="company-box-form" className="modal-body settings-stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
        <label>App address<input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required placeholder={entry.baseUrlExample ?? "https://app.your-tailnet.ts.net"} inputMode="url" autoComplete="off" /></label>
        <p className="muted-detail field-help">The app's https:// address, usually on your tailnet (*.ts.net). Marketplace itself must be able to reach your tailnet.</p>
        {entry.credentials.length > 0 && <fieldset className="header-rows">
          <legend>Credentials</legend>
          <p className="muted-detail">Encrypted on the server and never shown again.</p>
          {entry.credentials.map((field) => {
            const saved = field.configured && modes[field.key] !== "replace";
            return saved ? <div className="header-row header-row--saved" key={field.key}>
              <span>{field.label}</span>
              <span className="header-row__saved"><KeyRound size={13} />Saved{field.fingerprint ? <> · <code>{field.fingerprint}</code></> : null}</span>
              <div className="dialog-actions"><Button size="small" type="button" onClick={() => setModes((current) => together ? Object.fromEntries(entry.credentials.map((item) => [item.key, "replace"])) : { ...current, [field.key]: "replace" })}>Replace</Button></div>
            </div> : <div className="header-row" key={field.key}>
              <span>{field.label}</span>
              <input aria-label={field.label} type={field.secret ? "password" : "text"} autoComplete={field.secret ? "new-password" : "off"} value={values[field.key] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} required placeholder={field.secret ? "Secret value" : field.label} />
              {field.configured ? <div className="dialog-actions"><Button size="small" type="button" onClick={() => { setModes((current) => together ? {} : { ...current, [field.key]: "keep" }); setValues((current) => together ? {} : { ...current, [field.key]: "" }); }}><Undo2 size={13} />Keep saved</Button></div> : <span />}
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
