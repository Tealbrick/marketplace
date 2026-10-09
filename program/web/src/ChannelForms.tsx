import { useId, useMemo, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Check, LoaderCircle, Radar, Save, X } from "lucide-react";
import { Button, Tag } from "@tealbrick/ui";

import { ApiError } from "./api";
import { createChannel, discoverChannels, newChannelKey, updateChannel } from "./channels-api";
import {
  CHANNEL_PROVIDERS,
  declarationFor,
  KIND_LABEL,
  kindsFor,
  formatBytes,
  formToPolicy,
  grantFieldLabel,
  grantsAboveCeiling,
  labelProblem,
  policyToForm,
  PROVIDER_LABEL,
  providerFileLimits,
  slugFromLabel,
  slugProblem,
  typeName,
  WEEKDAYS,
  type PolicyForm,
} from "./channels-model";
import { DISCORD_DISCOVER_HINT, TELEGRAM_DISCOVER_HINT } from "./copy";
import type { ChannelDestination, ChannelProviderCapabilities, ChannelProviderEntry, ChannelProviderId, ChannelsBrowseResponse, ChannelView, StandingGrantView } from "./types";
import { InlineError } from "./ui";

/** Field-level reasons from a refusal body (`fields` for grants, `errors` for policies). Plain text only. */
export function RefusalFields({ error }: { error: unknown }) {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== "object") return null;
  const body = error.body as { fields?: unknown; errors?: unknown };
  const fields = Array.isArray(body.fields) ? body.fields.filter((field): field is string => typeof field === "string") : [];
  const errors = Array.isArray(body.errors)
    ? body.errors.flatMap((entry) => (entry && typeof entry === "object" && typeof (entry as { field?: unknown }).field === "string" ? [{ field: String((entry as { field: string }).field), message: typeof (entry as { message?: unknown }).message === "string" ? String((entry as { message: string }).message) : "" }] : []))
    : [];
  if (!fields.length && !errors.length) return null;
  return <ul className="refusal-fields" aria-label="Refused fields">
    {fields.map((field) => <li key={field}>{grantFieldLabel(field)}</li>)}
    {errors.map((entry, index) => <li key={`${entry.field}-${index}`}><strong>{POLICY_FIELD_LABEL[entry.field] ?? entry.field}</strong>{entry.message ? `: ${entry.message}` : ""}</li>)}
  </ul>;
}

export function RefusalNotice({ error }: { error: Error }) {
  return <div className="refusal"><InlineError error={error} /><RefusalFields error={error} /></div>;
}

const POLICY_FIELD_LABEL: Record<string, string> = {
  standingGrants: "Standing grants",
  "caps.perDay": "Posts per day",
  "caps.perHour": "Posts per hour",
  "caps.minIntervalSeconds": "Minimum gap",
  "caps.onePerPhase": "One post per phase",
  "content.maxChars": "Text length",
  "content.files.allowed": "Files",
  "content.files.types": "File types",
  "content.files.maxBytes": "File size",
  "content.files.maxCount": "Files per post",
  "content.requireConfirmedEvent": "Confirmed event",
  "content.listingHosts": "Listing hosts",
  "content.denyPatterns": "Blocked words",
  "schedule.window": "Schedule window",
};

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  return message ? <span className="field-error" id={id} role="alert">{message}</span> : null;
}

/**
 * Label + control + hint + error. The hint and error stay outside the
 * `<label>` (so they never change the accessible name) and are linked with
 * `aria-describedby`.
 */
function LabeledField({ label, hint, error, className, children }: { label: string; hint?: ReactNode; error?: string; className?: string; children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode }) {
  const id = useId();
  const described = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return <div className={`labeled-field${className ? ` ${className}` : ""}`}>
    <label htmlFor={id}>{label}</label>
    {children({ id, "aria-describedby": described, ...(error ? { "aria-invalid": true as const } : {}) })}
    {hint && <span className="field-hint" id={`${id}-hint`}>{hint}</span>}
    <FieldError id={`${id}-error`} message={error} />
  </div>;
}

/** The owner ceiling (§4.3). File choices are limited to what the provider declares. */
export function PolicyFields({ form, onChange, declaration, errors }: { form: PolicyForm; onChange: (form: PolicyForm) => void; declaration: ChannelProviderCapabilities | null; errors: Partial<Record<keyof PolicyForm, string>> }) {
  const id = useId();
  const set = <K extends keyof PolicyForm>(key: K, value: PolicyForm[K]) => onChange({ ...form, [key]: value });
  const limits = declaration ? providerFileLimits(declaration) : null;
  const numberInput = (key: "perDay" | "perHour" | "minIntervalSeconds" | "maxChars" | "fileMaxMiB" | "fileMaxCount", label: string, extra: { min?: number; max?: number; step?: string; placeholder?: string; help?: string } = {}) => (
    <LabeledField label={label} hint={extra.help} error={errors[key]}>
      {(props) => <input {...props} type="number" inputMode="numeric" min={extra.min} max={extra.max} step={extra.step ?? "1"} placeholder={extra.placeholder} value={form[key]} onChange={(event) => set(key, event.target.value)} />}
    </LabeledField>
  );
  return <fieldset className="channel-policy">
    <legend>Posting rules (ceiling for every agent)</legend>
    <p className="muted-detail">These limits are shared by all agents on this channel. Approvals and standing grants never go above them.</p>
    <div className="form-grid two">
      {numberInput("perDay", "Posts per day", { min: 1, max: 10_000 })}
      {numberInput("perHour", "Posts per hour", { min: 1, max: 10_000, placeholder: "No hourly limit" })}
      {numberInput("minIntervalSeconds", "Minimum gap (seconds)", { min: 0, max: 604_800, help: "600 = 10 minutes between posts." })}
      {numberInput("maxChars", "Text length limit", { min: 1, max: declaration?.text.maxChars, placeholder: declaration ? `Provider limit: ${declaration.text.maxChars}` : "Provider limit" })}
    </div>
    <label className="confirm-check"><input type="checkbox" checked={form.onePerPhase} onChange={(event) => set("onePerPhase", event.target.checked)} />One post per campaign phase (announce, reminder, recap, update)</label>
    <label className="channel-select">Standing grants
      <select value={form.standingGrants} onChange={(event) => set("standingGrants", event.target.value as PolicyForm["standingGrants"])}>
        <option value="disabled">Off: every post waits for my approval</option>
        <option value="allowed">Allowed: agents may propose standing grants for me to approve</option>
      </select>
    </label>

    <fieldset className="header-rows">
      <legend>Files</legend>
      {limits && limits.types.length === 0
        ? <p className="muted-detail">This provider can't send files.</p>
        : <>
          <label className="confirm-check"><input type="checkbox" checked={form.filesAllowed} onChange={(event) => set("filesAllowed", event.target.checked)} />Allow attachments</label>
          {form.filesAllowed && <>
            <div className="checkbox-grid" role="group" aria-label="Allowed file types" aria-describedby={errors.fileTypes ? `${id}-fileTypes` : undefined}>
              {(limits?.types ?? form.fileTypes).map((type) => <label key={type} className="confirm-check"><input type="checkbox" checked={form.fileTypes.includes(type)} onChange={(event) => set("fileTypes", event.target.checked ? [...form.fileTypes, type] : form.fileTypes.filter((entry) => entry !== type))} />{typeName(type)}</label>)}
            </div>
            <FieldError id={`${id}-fileTypes`} message={errors.fileTypes} />
            <div className="form-grid two">
              {numberInput("fileMaxMiB", "Largest file (MiB)", { min: 0.01, max: limits ? limits.maxBytes / (1024 * 1024) : undefined, step: "0.01", help: limits ? `Provider limit: ${formatBytes(limits.maxBytes)} (per kind, see capabilities).` : undefined })}
              {numberInput("fileMaxCount", "Files per post", { min: 0, max: limits?.maxCount, help: limits ? `Provider limit: ${limits.maxCount}.` : undefined })}
            </div>
          </>}
        </>}
    </fieldset>

    <LabeledField className="channel-textarea" label="Blocked words and phrases (one per line)" hint="A post that contains one of these is refused (case-insensitive)." error={errors.denyPatterns}>
      {(props) => <textarea {...props} rows={3} value={form.denyPatterns} onChange={(event) => set("denyPatterns", event.target.value)} />}
    </LabeledField>

    <fieldset className="header-rows">
      <legend>Confirmed events</legend>
      <label className="confirm-check"><input type="checkbox" checked={form.requireConfirmedEvent} onChange={(event) => set("requireConfirmedEvent", event.target.checked)} />Only post about events whose listing page is live (checked at send time)</label>
      <LabeledField className="channel-textarea" label="Listing hosts (one per line)" hint="An exact host or its subdomains, for example lu.ma." error={errors.listingHosts}>
        {(props) => <textarea {...props} rows={2} value={form.listingHosts} onChange={(event) => set("listingHosts", event.target.value)} placeholder="lu.ma" />}
      </LabeledField>
    </fieldset>

    <fieldset className="header-rows">
      <legend>Schedule window</legend>
      <label className="confirm-check"><input type="checkbox" checked={form.windowEnabled} onChange={(event) => set("windowEnabled", event.target.checked)} />Only post inside a daily time window</label>
      {form.windowEnabled && <>
        <div className="form-grid two">
          <LabeledField label="Time zone" error={errors.timeZone}>{(props) => <input {...props} value={form.timeZone} onChange={(event) => set("timeZone", event.target.value)} placeholder="Asia/Taipei" />}</LabeledField>
          <div className="form-grid two">
            <label>From<input type="time" value={form.windowStart} aria-describedby={errors.windowStart ? `${id}-windowStart` : undefined} onChange={(event) => set("windowStart", event.target.value)} /></label>
            <label>Until<input type="time" value={form.windowEnd} onChange={(event) => set("windowEnd", event.target.value)} /></label>
          </div>
        </div>
        <FieldError id={`${id}-windowStart`} message={errors.windowStart} />
        <div className="checkbox-grid weekdays" role="group" aria-label="Days (none checked means every day)">
          {WEEKDAYS.map((day, index) => <label key={day} className="confirm-check"><input type="checkbox" checked={form.windowDays.includes(index)} onChange={(event) => set("windowDays", event.target.checked ? [...form.windowDays, index] : form.windowDays.filter((entry) => entry !== index))} />{day}</label>)}
        </div>
      </>}
    </fieldset>
  </fieldset>;
}

function plainTitle(title: string) {
  return title.replace(/[\p{Cc}​-‏‪-‮⁦-⁩﻿]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 80);
}

export function DestinationTitle({ destination }: { destination: Pick<ChannelDestination, "title" | "type"> }) {
  // Untrusted provider text: React renders it as text, never as markup.
  return <span className="destination-title" title={destination.title}>{destination.title || "Untitled"}</span>;
}

/** Discover → pick a destination → label, slug, audience and ceiling. */
export function CreateChannelPanel({ browse, onCreated, onCancel }: { browse: ChannelsBrowseResponse; onCreated: (channel: ChannelView) => void; onCancel: () => void }) {
  const id = useId();
  const ready = CHANNEL_PROVIDERS.filter((provider) => browse.readiness[provider] === "available");
  const [provider, setProvider] = useState<ChannelProviderId | "">(ready.length === 1 ? ready[0]! : "");
  const [destinationKey, setDestinationKey] = useState("");
  const [label, setLabel] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [kindChoice, setKindChoice] = useState("");
  const [audience, setAudience] = useState("");
  const [language, setLanguage] = useState("");
  const [purpose, setPurpose] = useState("");
  const declaration = provider ? declarationFor(browse.providers, provider) : null;
  const kinds = provider ? kindsFor(browse.providers, provider) : [];
  const [policyForm, setPolicyForm] = useState<PolicyForm>(() => policyToForm(null, declaration));
  const [showErrors, setShowErrors] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => newChannelKey("channel-create"));
  const discover = useMutation({ mutationFn: (target: ChannelProviderId) => discoverChannels(target) });
  const destinations = discover.data?.provider === provider ? discover.data.destinations : [];
  const keyOf = (destination: ChannelDestination) => `${destination.externalId}|${destination.parentId ?? ""}`;
  const destination = destinations.find((entry) => keyOf(entry) === destinationKey) ?? null;
  // Only kinds the provider lists; the only one is preselected.
  const kind = kinds.includes(kindChoice) ? kindChoice : kinds.length === 1 ? kinds[0]! : "";
  const taken = useMemo(() => browse.channels.map((channel) => channel.slug), [browse.channels]);
  const policy = formToPolicy(policyForm, declaration);
  const problems = {
    label: labelProblem(label),
    slug: slugProblem(slug, taken),
  };
  const valid = Boolean(provider && destination && kind && !problems.label && !problems.slug && policy.policy);
  const create = useMutation({
    mutationFn: () => createChannel({
      provider: provider as ChannelProviderId,
      slug,
      label: label.trim(),
      kind,
      destination: { externalId: destination!.externalId, ...(destination!.parentId ? { parentId: destination!.parentId } : {}) },
      ...(audience.trim() ? { audience: audience.trim() } : {}),
      ...(language.trim() ? { language: language.trim() } : {}),
      ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
      policy: policy.policy!,
    }, idempotencyKey),
    onSuccess: (result) => { setIdempotencyKey(newChannelKey("channel-create")); onCreated(result.channel); },
  });
  const chooseProvider = (next: ChannelProviderId) => {
    setProvider(next);
    setDestinationKey("");
    setPolicyForm(policyToForm(null, declarationFor(browse.providers, next)));
    setKindChoice("");
    discover.reset();
  };
  const pick = (entry: ChannelDestination) => {
    setDestinationKey(keyOf(entry));
    if (!label.trim()) {
      const suggested = plainTitle(entry.title);
      setLabel(suggested);
      if (!slugTouched) setSlug(slugFromLabel(suggested));
    }
  };
  const updateLabel = (value: string) => {
    setLabel(value);
    if (!slugTouched) setSlug(slugFromLabel(value));
  };
  const hint = provider === "telegram" ? TELEGRAM_DISCOVER_HINT : provider === "discord" ? DISCORD_DISCOVER_HINT : null;

  return <section className="channel-create" aria-labelledby={`${id}-title`}>
    <div className="section-heading"><div><p className="eyebrow">New channel</p><h3 id={`${id}-title`}>Add a destination</h3></div><Button size="small" onClick={onCancel} aria-label="Close new channel form"><X size={14} />Cancel</Button></div>
    <ol className="channel-steps">
      <li>
        <h4>1. Provider</h4>
        <div className="segmented" role="radiogroup" aria-label="Provider">
          {CHANNEL_PROVIDERS.map((entry) => {
            const available = browse.readiness[entry] === "available";
            return <label key={entry} className={provider === entry ? "is-selected" : ""}><input type="radio" name={`${id}-provider`} value={entry} checked={provider === entry} disabled={!available} onChange={() => chooseProvider(entry)} />{PROVIDER_LABEL[entry]}{!available && <small> · not ready</small>}</label>;
          })}
        </div>
        {!ready.length && <p className="inline-error" role="status"><AlertTriangle size={14} /><span>No provider is ready. Add a bot token in Teal Brick Portal first (see the cards above).</span></p>}
      </li>
      {provider && <li>
        <h4>2. Destination</h4>
        {hint && <p className="muted-detail">{hint}</p>}
        <Button size="small" onClick={() => discover.mutate(provider)} disabled={discover.isPending}>{discover.isPending ? <LoaderCircle className="spin" size={14} /> : <Radar size={14} />}Discover</Button>
        {discover.error && <InlineError error={discover.error} />}
        {discover.isSuccess && !destinations.length && <p className="muted-detail" role="status">No destinations found yet. {hint}</p>}
        {destinations.length > 0 && <div className="destination-list" role="radiogroup" aria-label="Discovered destinations">
          {destinations.map((entry) => <label key={keyOf(entry)} className={destinationKey === keyOf(entry) ? "is-selected" : ""}>
            <input type="radio" name={`${id}-destination`} checked={destinationKey === keyOf(entry)} onChange={() => pick(entry)} />
            <span><DestinationTitle destination={entry} /><small>{entry.type}{entry.parentId ? ` · in ${entry.parentId}` : ""} · <code>{entry.externalId}</code></small></span>
          </label>)}
        </div>}
      </li>}
      {destination && <li>
        <h4>3. Details and rules</h4>
        <form className="channel-form" onSubmit={(event) => { event.preventDefault(); setShowErrors(true); if (valid) create.mutate(); }} noValidate>
          <div className="form-grid two">
            <LabeledField label="Label" error={showErrors ? problems.label ?? undefined : undefined}>{(props) => <input {...props} value={label} maxLength={80} required onChange={(event) => updateLabel(event.target.value)} />}</LabeledField>
            <LabeledField label="Slug" hint={<>Agents see it as <code>channel:{slug || "…"}</code>.</>} error={showErrors || slugTouched ? problems.slug ?? undefined : undefined}>{(props) => <input {...props} value={slug} maxLength={48} required spellCheck={false} autoCapitalize="none" onChange={(event) => { setSlugTouched(true); setSlug(event.target.value); }} />}</LabeledField>
            <LabeledField label="Kind" error={showErrors && !kind ? "This provider lists no channel kind." : undefined}>{(props) => <select {...props} value={kind} onChange={(event) => setKindChoice(event.target.value)}>{kinds.length !== 1 && <option value="" disabled>Choose a kind</option>}{kinds.map((entry) => <option key={entry} value={entry}>{KIND_LABEL[entry] ?? entry}</option>)}</select>}</LabeledField>
            <label>Language<input value={language} maxLength={40} onChange={(event) => setLanguage(event.target.value)} placeholder="en, zh-TW…" /></label>
            <label>Audience<input value={audience} maxLength={500} onChange={(event) => setAudience(event.target.value)} placeholder="Who reads this channel" /></label>
            <label>Purpose<input value={purpose} maxLength={500} onChange={(event) => setPurpose(event.target.value)} placeholder="What agents may post here" /></label>
          </div>
          <PolicyFields form={policyForm} onChange={setPolicyForm} declaration={declaration} errors={showErrors ? policy.errors : {}} />
          {create.error && <RefusalNotice error={create.error} />}
          <div className="dialog-actions channel-form__actions"><Button type="button" onClick={onCancel} disabled={create.isPending}>Cancel</Button><Button tone="primary" type="submit" disabled={create.isPending}>{create.isPending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}Create channel</Button></div>
        </form>
      </li>}
    </ol>
  </section>;
}

/** Edit text and ceiling. Lowering the ceiling suspends grants above it (§4.4 rule 5). */
export function EditChannelPanel({ channel, providers, onSaved, onCancel }: { channel: ChannelView; providers: ChannelProviderEntry[]; onSaved: (channel: ChannelView, suspended: StandingGrantView[]) => void; onCancel: () => void }) {
  const id = useId();
  const declaration = declarationFor(providers, channel.provider);
  const [label, setLabel] = useState(channel.label);
  const [audience, setAudience] = useState(channel.audience);
  const [language, setLanguage] = useState(channel.language);
  const [purpose, setPurpose] = useState(channel.purpose);
  const [form, setForm] = useState(() => policyToForm(channel.policy, declaration));
  const [showErrors, setShowErrors] = useState(false);
  const policy = formToPolicy(form, declaration);
  const labelError = labelProblem(label);
  const affected = policy.policy ? grantsAboveCeiling(channel.grants, policy.policy) : [];
  const save = useMutation({
    mutationFn: () => updateChannel(channel.id, { label: label.trim(), audience: audience.trim(), language: language.trim(), purpose: purpose.trim(), policy: policy.policy!, expectRevision: channel.revision }),
    onSuccess: (result) => onSaved(result.channel, result.suspendedGrants),
  });
  return <form className="channel-form channel-edit" aria-labelledby={`${id}-title`} onSubmit={(event) => { event.preventDefault(); setShowErrors(true); if (policy.policy && !labelError) save.mutate(); }} noValidate>
    <div className="section-heading"><div><p className="eyebrow">Revision {channel.revision}</p><h3 id={`${id}-title`}>Edit channel</h3></div></div>
    <div className="form-grid two">
      <LabeledField label="Label" error={showErrors ? labelError ?? undefined : undefined}>{(props) => <input {...props} value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} />}</LabeledField>
      <label>Language<input value={language} maxLength={40} onChange={(event) => setLanguage(event.target.value)} /></label>
      <label>Audience<input value={audience} maxLength={500} onChange={(event) => setAudience(event.target.value)} /></label>
      <label>Purpose<input value={purpose} maxLength={500} onChange={(event) => setPurpose(event.target.value)} /></label>
    </div>
    <PolicyFields form={form} onChange={setForm} declaration={declaration} errors={showErrors ? policy.errors : {}} />
    <div className="contract-gap" role="note"><AlertTriangle size={18} /><div><strong>Lowering the ceiling suspends grants above it</strong><p>Active standing grants that no longer fit are suspended when you save. A suspended grant only resumes after you approve it again.</p>
      {affected.length > 0 && <p data-testid="grants-to-suspend">These active grants would be suspended: {affected.map((grant) => <Tag key={grant.id} tone="warning">{grant.agentId}</Tag>)}</p>}
    </div></div>
    {save.error && <RefusalNotice error={save.error} />}
    <div className="dialog-actions channel-form__actions"><Button type="button" onClick={onCancel} disabled={save.isPending}>Cancel</Button><Button tone="primary" type="submit" disabled={save.isPending}>{save.isPending ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}Save rules</Button></div>
  </form>;
}
