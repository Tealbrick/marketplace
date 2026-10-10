import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { KeyRound, LoaderCircle, RefreshCw, ShieldOff } from "lucide-react";
import { Button, Tag } from "@tealbrick/ui";

import { generateBuzzKey, revokeBuzzTag, updateBuzzIdentity } from "./channels-api";
import { buzzTagSummary, looksLikeSecretKey } from "./channels-model";
import { BUZZ_CUSTODY_COPY, BUZZ_REVOKE_COPY, BUZZ_ROTATE_COPY, BUZZ_SETUP_STEPS } from "./copy";
import type { BuzzIdentityResponse, BuzzIdentityView } from "./types";
import { formatWhen, InlineError } from "./ui";

/**
 * Owner panel for the Buzz connection identity (Coordinator custody model): the agent npub (never the secret),
 * the relay address, the text the owner signs on their own device, the pasted NIP-OA tag with its end date and
 * renewal reminder, and rotate / revoke with what each one does.
 */
export function BuzzIdentityPanel({ view, onChanged }: { view: BuzzIdentityView; onChanged: (message: string) => void }) {
  const id = useId();
  const [relayUrl, setRelayUrl] = useState(view.relay.url ?? "");
  const [tag, setTag] = useState("");
  const [confirm, setConfirm] = useState<"rotate" | "revoke" | null>(null);
  const [restartNote, setRestartNote] = useState(false);
  const done = (message: string) => (response: BuzzIdentityResponse) => {
    setRestartNote(Boolean(response.appliesAfterRestart));
    setConfirm(null);
    onChanged(message);
  };
  const generate = useMutation({ mutationFn: (rotate: boolean) => generateBuzzKey(rotate), onSuccess: (response, rotate) => done(rotate ? "Rotated the Buzz agent key." : "Generated the Buzz agent key.")(response) });
  const saveRelay = useMutation({ mutationFn: () => updateBuzzIdentity({ relayUrl: relayUrl.trim() }), onSuccess: done("Saved the Buzz relay address.") });
  const saveTag = useMutation({
    mutationFn: () => updateBuzzIdentity({ authTag: tag.trim() }),
    onSuccess: (response) => {
      setTag("");
      done("Saved the NIP-OA tag.")(response);
    },
  });
  const revoke = useMutation({ mutationFn: revokeBuzzTag, onSuccess: done("Revoked the NIP-OA tag.") });
  const summary = buzzTagSummary(view);
  const secretPasted = looksLikeSecretKey(tag);
  const busy = generate.isPending || saveRelay.isPending || saveTag.isPending || revoke.isPending;

  return <section className="buzz-identity" aria-labelledby={`${id}-title`}>
    <div className="section-heading"><div><p className="eyebrow">Buzz identity</p><h3 id={`${id}-title`}>Marketplace agent key</h3></div><Tag tone={summary.tone}>{summary.text}</Tag></div>
    <p className="muted-detail">{BUZZ_CUSTODY_COPY}</p>
    {view.secretStore === "unavailable" && <p className="inline-error" role="alert">The encrypted secret store is not configured, so Marketplace cannot make or keep a Buzz key.</p>}
    {restartNote && <p className="muted-detail" role="status">Channels are not on yet in this Marketplace. The Buzz identity takes effect after Marketplace restarts.</p>}
    {view.authTag.renewalDue && view.authTag.status === "valid" && <p className="inline-warning" role="alert">The NIP-OA tag ends {formatWhen(view.authTag.expiresAt)}. Sign a new tag before then, or Buzz stops working.</p>}

    <dl className="fact-list">
      <dt>Agent npub</dt><dd>{view.key.npub ? <code>{view.key.npub}</code> : "—"}</dd>
      <dt>Key made</dt><dd>{formatWhen(view.key.createdAt)}</dd>
      <dt>Relay</dt><dd>{view.relay.url ? <code>{view.relay.url}</code> : "Not set"}</dd>
      <dt>Tag owner</dt><dd>{view.authTag.ownerNpub ? <code>{view.authTag.ownerNpub}</code> : "—"}</dd>
      <dt>Tag ends</dt><dd>{formatWhen(view.authTag.expiresAt)}</dd>
      <dt>Tag digest</dt><dd>{view.authTag.sha256 ? <code>{view.authTag.sha256.slice(0, 16)}…</code> : "—"}</dd>
      <dt>Pinned owner key</dt><dd>{view.pinnedOwner.set ? <code>{view.pinnedOwner.fingerprint}</code> : "Not pinned (any owner key is accepted)"}</dd>
    </dl>

    {!view.key.present && <div className="buzz-step">
      <Button size="small" tone="primary" disabled={busy || view.secretStore === "unavailable"} onClick={() => generate.mutate(false)}>{generate.isPending ? <LoaderCircle className="spin" size={14} /> : <KeyRound size={14} />}Generate agent key</Button>
    </div>}

    <form className="buzz-step" onSubmit={(event) => { event.preventDefault(); saveRelay.mutate(); }}>
      <label>Relay address<input value={relayUrl} onChange={(event) => setRelayUrl(event.target.value)} placeholder="wss://your-relay.example" inputMode="url" autoComplete="off" spellCheck={false} /></label>
      <Button size="small" type="submit" disabled={busy || relayUrl.trim() === "" || relayUrl.trim() === view.relay.url}>Save relay</Button>
    </form>
    {saveRelay.error && <InlineError error={saveRelay.error} />}

    {view.signing && <details className="provider-setup" open={view.authTag.status !== "valid"}>
      <summary>Sign the NIP-OA tag on your own device</summary>
      <p className="muted-detail">Sign this exact text with your Buzz key (BIP-340 over its SHA-256). It allows the agent key until the end date in the conditions; at most {view.signing.maxDays} days. Marketplace reminds you {view.signing.reminderDays} days before the end.</p>
      <pre className="buzz-preimage"><code>{view.signing.preimage}</code></pre>
      <p className="muted-detail">Conditions: <code>{view.signing.suggestedConditions}</code>. Then paste the tag as <code>["auth", "&lt;your key hex&gt;", "&lt;conditions&gt;", "&lt;signature hex&gt;"]</code>.</p>
    </details>}

    {view.key.present && <form className="buzz-step" onSubmit={(event) => { event.preventDefault(); if (!secretPasted) saveTag.mutate(); }}>
      <label>NIP-OA tag<textarea value={tag} onChange={(event) => setTag(event.target.value)} rows={3} placeholder='["auth", "…", "created_at<…", "…"]' autoComplete="off" spellCheck={false} /></label>
      {secretPasted && <p className="inline-error" role="alert">This looks like a secret key. Never paste a secret key here; paste only the signed tag.</p>}
      <Button size="small" type="submit" disabled={busy || tag.trim() === "" || secretPasted}>Save tag</Button>
    </form>}
    {saveTag.error && <InlineError error={saveTag.error} />}
    {generate.error && <InlineError error={generate.error} />}
    {revoke.error && <InlineError error={revoke.error} />}

    {view.key.present && <div className="buzz-step buzz-danger">
      {confirm === null && <>
        <Button size="small" disabled={busy} onClick={() => setConfirm("rotate")}><RefreshCw size={14} />Rotate key…</Button>
        {view.authTag.status !== "missing" && <Button size="small" disabled={busy} onClick={() => setConfirm("revoke")}><ShieldOff size={14} />Revoke tag…</Button>}
      </>}
      {confirm !== null && <div role="alertdialog" aria-label={confirm === "rotate" ? "Rotate the Buzz agent key" : "Revoke the NIP-OA tag"}>
        <p>{confirm === "rotate" ? BUZZ_ROTATE_COPY : BUZZ_REVOKE_COPY}</p>
        <Button size="small" tone="danger" disabled={busy} onClick={() => (confirm === "rotate" ? generate.mutate(true) : revoke.mutate())}>{confirm === "rotate" ? "Rotate now" : "Revoke now"}</Button>
        <Button size="small" onClick={() => setConfirm(null)}>Cancel</Button>
      </div>}
    </div>}

    {view.authTag.status !== "valid" && <details className="provider-setup">
      <summary>Set up Buzz</summary>
      <ol>{BUZZ_SETUP_STEPS.map((step) => <li key={step}>{step}</li>)}</ol>
    </details>}
  </section>;
}
