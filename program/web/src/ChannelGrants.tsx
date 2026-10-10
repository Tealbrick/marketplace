import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, CircleSlash, Clock3, LoaderCircle, Scissors, ShieldCheck, XCircle } from "lucide-react";
import { Button, Tag } from "@tealbrick/ui";

import { approveGrant, declineGrant, revokeGrant } from "./channels-api";
import {
  cleanTerms,
  digestPrefix,
  formatBytes,
  formatSeconds,
  fromLocalInput,
  GRANT_PHASES,
  GRANT_STATUS_LABEL,
  grantFieldLabel,
  grantFlags,
  grantTerms,
  GRANT_SCOPE_FLAGS,
  grantTone,
  MIB,
  toLocalInput,
  typeName,
  wideningFields,
} from "./channels-model";
import { RefusalNotice } from "./ChannelForms";
import type { ChannelView, GrantPhase, GrantScopeFlag, GrantTerms, StandingGrantView } from "./types";
import { formatWhen } from "./ui";

function capCell(value: number | undefined, format: (value: number) => string = String) {
  return value === undefined ? "No limit" : format(value);
}

function filesText(files: StandingGrantView["scope"]["files"]) {
  if (files === false) return "No files";
  const parts = [files.types ? files.types.map(typeName).join(", ") : "Any allowed type", files.maxBytes !== undefined ? `up to ${formatBytes(files.maxBytes)}` : null, files.maxCount !== undefined ? `${files.maxCount} per post` : null];
  return parts.filter(Boolean).join(" · ");
}

/** Grant caps next to the channel ceiling: the effective cap is always the tighter one. */
function CapsVsCeiling({ grant, channel }: { grant: StandingGrantView; channel: ChannelView | undefined }) {
  const ceiling = channel?.policy;
  const rows: Array<[string, string, string]> = [
    ["Posts per day", String(grant.caps.perDay), ceiling ? String(ceiling.caps.perDay) : "—"],
    ["Posts per hour", capCell(grant.caps.perHour), ceiling ? capCell(ceiling.caps.perHour) : "—"],
    ["Minimum gap", formatSeconds(grant.caps.minIntervalSeconds), ceiling ? formatSeconds(ceiling.caps.minIntervalSeconds) : "—"],
    ["One per phase", grant.caps.onePerPhase ? "Yes" : "No", ceiling ? (ceiling.caps.onePerPhase ? "Yes" : "No") : "—"],
    ["Text length", capCell(grant.scope.maxChars), ceiling ? capCell(ceiling.content.maxChars) : "—"],
  ];
  return <table className="caps-table">
    <caption className="visually-hidden">Grant limits compared with the channel ceiling</caption>
    <thead><tr><th scope="col">Limit</th><th scope="col">Grant</th><th scope="col">Ceiling</th></tr></thead>
    <tbody>{rows.map(([label, value, limit]) => <tr key={label}><th scope="row">{label}</th><td>{value}</td><td>{limit}</td></tr>)}</tbody>
  </table>;
}

function GrantScope({ grant }: { grant: StandingGrantView }) {
  const modes = [grant.scope.immediate ? "immediate" : null, grant.scope.scheduled ? "scheduled" : null].filter(Boolean).join(" and ");
  return <dl className="fact-list grant-scope">
    <dt>Phases</dt><dd>{grant.scope.phases?.join(", ") ?? "Any phase"}</dd>
    <dt>Campaign links</dt><dd>{grant.scope.campaignRefs ? <ul className="plain-list">{grant.scope.campaignRefs.map((ref) => <li key={ref}><code>{ref}</code></li>)}</ul> : "Any campaign"}</dd>
    <dt>Files</dt><dd>{filesText(grant.scope.files)}</dd>
    <dt>Post modes</dt><dd>{modes || "None"}</dd>
    <dt>Also covers</dt><dd>{grantFlags(grant.scope).length ? GRANT_SCOPE_FLAGS.filter(([flag]) => grant.scope[flag] === true).map(([, label]) => label).join(", ") : "Posts only (reactions, edits, deletes, polls and direct messages wait for you)"}</dd>
    <dt>Valid</dt><dd>{grant.notBefore ? `${formatWhen(grant.notBefore)} – ` : "Until "}{formatWhen(grant.expires)}</dd>
    <dt>Digest</dt><dd><code title={grant.digest}>{digestPrefix(grant.digest)}</code></dd>
  </dl>;
}

type Draft = {
  perDay: string;
  perHour: string;
  minIntervalSeconds: string;
  onePerPhase: boolean;
  phases: GrantPhase[] | null;
  campaignRefs: string[] | null;
  filesOn: boolean;
  fileTypes: string[] | null;
  fileMaxMiB: string;
  fileMaxCount: string;
  maxChars: string;
  immediate: boolean;
  scheduled: boolean;
  flags: Partial<Record<GrantScopeFlag, boolean>>;
  expires: string;
  notBefore: string;
};

function draftOf(grant: StandingGrantView): Draft {
  const files = grant.scope.files;
  return {
    perDay: String(grant.caps.perDay),
    perHour: grant.caps.perHour !== undefined ? String(grant.caps.perHour) : "",
    minIntervalSeconds: String(grant.caps.minIntervalSeconds),
    onePerPhase: grant.caps.onePerPhase,
    phases: grant.scope.phases ? [...grant.scope.phases] : null,
    campaignRefs: grant.scope.campaignRefs ? [...grant.scope.campaignRefs] : null,
    filesOn: files !== false,
    fileTypes: files !== false && files.types ? [...files.types] : null,
    fileMaxMiB: files !== false && files.maxBytes !== undefined ? String(Number((files.maxBytes / MIB).toFixed(2))) : "",
    fileMaxCount: files !== false && files.maxCount !== undefined ? String(files.maxCount) : "",
    maxChars: grant.scope.maxChars !== undefined ? String(grant.scope.maxChars) : "",
    immediate: grant.scope.immediate,
    scheduled: grant.scope.scheduled,
    flags: Object.fromEntries(grantFlags(grant.scope).map((flag) => [flag, true])),
    expires: toLocalInput(grant.expires),
    notBefore: toLocalInput(grant.notBefore),
  };
}

const optionalNumber = (value: string) => (value.trim() === "" ? undefined : Number(value));

/** The final terms from the draft. Untouched times keep their exact stored value. */
function termsOf(draft: Draft, grant: StandingGrantView): GrantTerms {
  const original = draftOf(grant);
  const files = grant.scope.files;
  return cleanTerms({
    caps: { perDay: Number(draft.perDay), perHour: optionalNumber(draft.perHour), minIntervalSeconds: Number(draft.minIntervalSeconds), onePerPhase: draft.onePerPhase },
    scope: {
      phases: draft.phases ?? undefined,
      campaignRefs: draft.campaignRefs ?? undefined,
      files: draft.filesOn && files !== false
        ? {
            types: draft.fileTypes ?? undefined,
            maxBytes: draft.fileMaxMiB.trim() === "" ? undefined : Math.round(Number(draft.fileMaxMiB) * MIB),
            maxCount: optionalNumber(draft.fileMaxCount),
          }
        : false,
      maxChars: optionalNumber(draft.maxChars),
      immediate: draft.immediate,
      scheduled: draft.scheduled,
      ...Object.fromEntries(Object.entries(draft.flags).filter(([, on]) => on === true)),
    },
    notBefore: draft.notBefore === original.notBefore ? grant.notBefore : fromLocalInput(draft.notBefore),
    expires: draft.expires === original.expires ? grant.expires : (fromLocalInput(draft.expires) ?? ""),
  });
}

/**
 * Narrow-then-approve (§4.4 rule 2). The editor only offers tightening
 * (lower numbers, subsets, an earlier expiry) and refuses any widening before
 * the request; the server enforces the same rule and its refusal is shown.
 */
export function NarrowEditor({ grant, channel, onDone, onCancel }: { grant: StandingGrantView; channel: ChannelView | undefined; onDone: (grant: StandingGrantView) => void; onCancel: () => void }) {
  const id = useId();
  const [draft, setDraft] = useState<Draft>(() => draftOf(grant));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const terms = termsOf(draft, grant);
  const widening = wideningFields(grantTerms(grant), terms);
  const approve = useMutation({ mutationFn: () => approveGrant(grant.id, terms), onSuccess: (result) => onDone(result.grant) });
  const files = grant.scope.files;
  const ceilingTypes = channel?.policy.content.files.types ?? [];
  const typeOptions = files !== false ? files.types ?? ceilingTypes : [];
  const number = (key: "perDay" | "perHour" | "minIntervalSeconds" | "maxChars" | "fileMaxCount" | "fileMaxMiB", label: string, bounds: { min?: number; max?: number; step?: string; placeholder?: string }) => (
    <label>{label}<input type="number" inputMode="numeric" step={bounds.step ?? "1"} min={bounds.min} max={bounds.max} placeholder={bounds.placeholder} value={draft[key]} onChange={(event) => set(key, event.target.value)} aria-invalid={widening.some((field) => field.endsWith(key === "fileMaxMiB" ? "maxBytes" : key)) ? true : undefined} /></label>
  );
  const toggle = <T extends string>(list: T[] | null, value: T, on: boolean) => (list ? (on ? [...list, value] : list.filter((entry) => entry !== value)) : list);
  return <form className="narrow-editor" aria-labelledby={`${id}-title`} onSubmit={(event) => { event.preventDefault(); if (!widening.length) approve.mutate(); }}>
    <h4 id={`${id}-title`}><Scissors size={14} aria-hidden="true" />Narrow, then approve</h4>
    <p className="muted-detail">You can only tighten this proposal: lower numbers, fewer phases or file types, an earlier expiry. To allow more, the agent proposes again.</p>
    <div className="form-grid two">
      {number("perDay", "Posts per day", { min: 1, max: grant.caps.perDay })}
      {number("perHour", "Posts per hour", { min: 1, max: grant.caps.perHour ?? channel?.policy.caps.perHour, placeholder: grant.caps.perHour === undefined ? "Ceiling applies" : undefined })}
      {number("minIntervalSeconds", "Minimum gap (seconds)", { min: grant.caps.minIntervalSeconds })}
      {number("maxChars", "Text length", { min: 1, max: grant.scope.maxChars ?? channel?.policy.content.maxChars, placeholder: grant.scope.maxChars === undefined ? "Ceiling applies" : undefined })}
    </div>
    <label className="confirm-check"><input type="checkbox" checked={draft.onePerPhase} disabled={grant.caps.onePerPhase} onChange={(event) => set("onePerPhase", event.target.checked)} />One post per campaign phase</label>
    <fieldset className="header-rows">
      <legend>Phases</legend>
      <div className="checkbox-grid" role="group" aria-label="Phases">
        {(grant.scope.phases ?? GRANT_PHASES).map((phase) => <label key={phase} className="confirm-check"><input type="checkbox" checked={draft.phases ? draft.phases.includes(phase) : true} onChange={(event) => set("phases", toggle(draft.phases ?? [...GRANT_PHASES], phase, event.target.checked))} />{phase}</label>)}
      </div>
      {!grant.scope.phases && <p className="muted-detail">Proposed for any phase. Uncheck phases to limit it.</p>}
    </fieldset>
    {grant.scope.campaignRefs && <fieldset className="header-rows">
      <legend>Campaign links</legend>
      {grant.scope.campaignRefs.map((ref) => <label key={ref} className="confirm-check"><input type="checkbox" checked={draft.campaignRefs?.includes(ref) ?? true} onChange={(event) => set("campaignRefs", toggle(draft.campaignRefs, ref, event.target.checked))} /><code>{ref}</code></label>)}
    </fieldset>}
    <fieldset className="header-rows">
      <legend>Files</legend>
      <label className="confirm-check"><input type="checkbox" checked={draft.filesOn} disabled={files === false} onChange={(event) => set("filesOn", event.target.checked)} />Allow files under this grant</label>
      {draft.filesOn && files !== false && <>
        {typeOptions.length > 0 && <div className="checkbox-grid" role="group" aria-label="File types">
          {typeOptions.map((type) => <label key={type} className="confirm-check"><input type="checkbox" checked={draft.fileTypes ? draft.fileTypes.includes(type) : true} onChange={(event) => set("fileTypes", toggle(draft.fileTypes ?? [...typeOptions], type, event.target.checked))} />{typeName(type)}</label>)}
        </div>}
        <div className="form-grid two">
          {number("fileMaxMiB", "Largest file (MiB)", { min: 0.01, step: "0.01", max: files.maxBytes !== undefined ? files.maxBytes / MIB : undefined, placeholder: files.maxBytes === undefined ? "Ceiling applies" : undefined })}
          {number("fileMaxCount", "Files per post", { min: 0, max: files.maxCount, placeholder: files.maxCount === undefined ? "Ceiling applies" : undefined })}
        </div>
      </>}
    </fieldset>
    <div className="checkbox-grid" role="group" aria-label="Post modes">
      <label className="confirm-check"><input type="checkbox" checked={draft.immediate} disabled={!grant.scope.immediate} onChange={(event) => set("immediate", event.target.checked)} />Immediate posts</label>
      <label className="confirm-check"><input type="checkbox" checked={draft.scheduled} disabled={!grant.scope.scheduled} onChange={(event) => set("scheduled", event.target.checked)} />Scheduled posts</label>
    </div>
    {grantFlags(grant.scope).length > 0 && <div className="checkbox-grid" role="group" aria-label="Also covers">
      {GRANT_SCOPE_FLAGS.filter(([flag]) => grant.scope[flag] === true).map(([flag, label]) => <label key={flag} className="confirm-check"><input type="checkbox" checked={draft.flags[flag] === true} onChange={(event) => set("flags", { ...draft.flags, [flag]: event.target.checked })} />{label}</label>)}
    </div>}
    <div className="form-grid two">
      <label>Starts<input type="datetime-local" value={draft.notBefore} min={toLocalInput(grant.notBefore) || undefined} max={draft.expires || undefined} onChange={(event) => set("notBefore", event.target.value)} /></label>
      <label>Expires<input type="datetime-local" value={draft.expires} max={toLocalInput(grant.expires)} required onChange={(event) => set("expires", event.target.value)} /></label>
    </div>
    {widening.length > 0 && <p className="inline-error" role="alert"><span><strong>You can only tighten the proposal.</strong> Check these fields, or reset: {widening.map(grantFieldLabel).join(", ")}.</span></p>}
    {approve.error && <RefusalNotice error={approve.error} />}
    <div className="dialog-actions"><Button size="small" type="button" onClick={onCancel} disabled={approve.isPending}>Cancel</Button><Button size="small" type="button" onClick={() => setDraft(draftOf(grant))} disabled={approve.isPending}>Reset</Button><Button size="small" tone="primary" type="submit" disabled={approve.isPending || widening.length > 0}>{approve.isPending ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Approve narrowed grant</Button></div>
  </form>;
}

export function GrantCard({ grant, channel, onNotice }: { grant: StandingGrantView; channel: ChannelView | undefined; onNotice: (notice: string) => void }) {
  const [narrowing, setNarrowing] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const label = channel?.label ?? grant.channelId;
  const approve = useMutation({ mutationFn: () => approveGrant(grant.id), onSuccess: () => onNotice(`Approved the standing grant for ${grant.agentId} on ${label}.`) });
  const decline = useMutation({ mutationFn: () => declineGrant(grant.id), onSuccess: () => onNotice(`Declined the proposal from ${grant.agentId}.`) });
  const revoke = useMutation({ mutationFn: () => revokeGrant(grant.id), onSuccess: () => { setConfirmRevoke(false); onNotice(`Revoked the standing grant for ${grant.agentId} on ${label}.`); } });
  const busy = approve.isPending || decline.isPending || revoke.isPending;
  const decidable = grant.status === "proposed" || grant.status === "suspended";
  const revocable = grant.status === "active" || grant.status === "suspended" || grant.status === "proposed";
  const error = approve.error ?? decline.error ?? revoke.error;
  return <article className="grant-card" aria-label={`Standing grant for ${grant.agentId} on ${label}`}>
    <header>
      <span className="agent-grant-row__icon"><ShieldCheck size={17} /></span>
      <div>
        <strong className="grant-purpose">{grant.purpose}</strong>
        <p><code>{grant.agentId}</code> on <strong>{label}</strong> · proposed {formatWhen(grant.proposedAt)}</p>
      </div>
      <Tag tone={grantTone(grant.status)}>{GRANT_STATUS_LABEL[grant.status] ?? grant.status}</Tag>
    </header>
    {grant.status === "suspended" && <p className="muted-detail"><Clock3 size={12} aria-hidden="true" /> Suspended{grant.reason ? ` (${grant.reason.replace(/_/gu, " ")})` : ""}. It resumes only if you approve it again.</p>}
    <div className="grant-card__body">
      <CapsVsCeiling grant={grant} channel={channel} />
      <GrantScope grant={grant} />
    </div>
    {error && <RefusalNotice error={error} />}
    {narrowing
      ? <NarrowEditor grant={grant} channel={channel} onCancel={() => setNarrowing(false)} onDone={() => { setNarrowing(false); onNotice(`Approved a narrowed standing grant for ${grant.agentId} on ${label}.`); }} />
      : <div className="dialog-actions">
        {decidable && <Button size="small" tone="primary" disabled={busy} onClick={() => approve.mutate()}>{approve.isPending ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{grant.status === "suspended" ? "Approve again" : "Approve"}</Button>}
        {decidable && <Button size="small" disabled={busy} onClick={() => setNarrowing(true)}><Scissors size={14} />Narrow, then approve</Button>}
        {grant.status === "proposed" && <Button size="small" disabled={busy} onClick={() => decline.mutate()}>{decline.isPending ? <LoaderCircle className="spin" size={14} /> : <CircleSlash size={14} />}Decline</Button>}
        {revocable && grant.status !== "proposed" && (confirmRevoke
          ? <><Button size="small" tone="danger" disabled={busy} onClick={() => revoke.mutate()}>{revoke.isPending ? <LoaderCircle className="spin" size={14} /> : <XCircle size={14} />}Confirm revoke</Button><Button size="small" disabled={busy} onClick={() => setConfirmRevoke(false)}>Keep</Button></>
          : <Button size="small" tone="danger" disabled={busy} onClick={() => setConfirmRevoke(true)}><XCircle size={14} />Revoke</Button>)}
      </div>}
    {confirmRevoke && <p className="muted-detail">Revoking takes effect at once. Scheduled posts under this grant are skipped.</p>}
  </article>;
}

/** Proposed grants first, then active ones, then the rest with their status chips. */
export function GrantInbox({ channels, onNotice }: { channels: ChannelView[]; onNotice: (notice: string) => void }) {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const grants = channels.flatMap((channel) => channel.grants);
  const proposed = grants.filter((grant) => grant.status === "proposed");
  const suspended = grants.filter((grant) => grant.status === "suspended");
  const active = grants.filter((grant) => grant.status === "active");
  const ended = grants.filter((grant) => !["proposed", "suspended", "active"].includes(grant.status));
  return <section className="channel-section" aria-labelledby="grant-inbox-heading">
    <div className="section-heading"><div><p className="eyebrow">Agents asking for standing permission</p><h2 id="grant-inbox-heading">Standing grants</h2></div><Tag tone={proposed.length ? "warning" : "default"} aria-label={`${proposed.length} proposals waiting`}>{proposed.length}</Tag></div>
    <p className="section-copy">A standing grant lets one agent post within limits you approve, without asking each time. You can approve it as proposed, narrow it first, or decline it.</p>
    {proposed.length || suspended.length
      ? <div className="grant-list">{[...proposed, ...suspended].map((grant) => <GrantCard key={grant.id} grant={grant} channel={byId.get(grant.channelId)} onNotice={onNotice} />)}</div>
      : <p className="muted-detail">No proposals waiting.</p>}
    {active.length > 0 && <><h3 className="subsection-title">Active</h3><div className="grant-list">{active.map((grant) => <GrantCard key={grant.id} grant={grant} channel={byId.get(grant.channelId)} onNotice={onNotice} />)}</div></>}
    {ended.length > 0 && <details className="technical-details"><summary>Ended grants ({ended.length})</summary><div className="grant-list">{ended.map((grant) => <GrantCard key={grant.id} grant={grant} channel={byId.get(grant.channelId)} onNotice={onNotice} />)}</div></details>}
  </section>;
}
