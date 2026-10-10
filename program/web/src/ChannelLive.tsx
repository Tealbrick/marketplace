import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleSlash, LoaderCircle, Mic, Pause, Play, Square, XCircle } from "lucide-react";
import { Button, Tag } from "@tealbrick/ui";

import { approveLiveGrant, getLiveOverview, getLiveTranscript, liveGrantAction, stopLiveSession, updateLiveControl } from "./channels-api";
import type { LiveGrantView, LiveSessionView } from "./types";
import { formatWhen, InlineError } from "./ui";

// Live sessions (Channels P2 scope 2.3): the owner approves the exact live-session grant (canonical JSON + digest),
// sees the consent values and caps before anything else, stops sessions, and reads transcripts. Approve, resume and
// the command channel need the pinned owner's own launch session (the server refuses anything else).

const STATUS_TONE: Partial<Record<LiveGrantView["status"], "success" | "warning" | "danger" | "accent">> = {
  proposed: "accent",
  active: "success",
  paused: "warning",
  revoked: "danger",
  declined: "danger",
};

const yesNo = (value: boolean) => (value ? "Yes" : "No");

function modesText(modes: { listen?: boolean; speakApproved?: boolean; speakLive?: boolean }) {
  const parts = [modes.listen && "listen (speech-to-text)", modes.speakApproved && "speak approved clips", modes.speakLive && "speak live text (text-to-speech)"].filter(Boolean);
  return parts.join(", ") || "none";
}

/** The consent values first and prominent: the owner approves them as part of the digest. */
function ConsentBlock({ grant }: { grant: LiveGrantView }) {
  const consent = grant.summary?.consent;
  if (!consent) return null;
  return <div className="live-consent" role="group" aria-label="Consent values in this grant">
    <p><strong>Disclosure notice in the channel:</strong> <Tag tone={consent.disclosureNotice ? "success" : "danger"}>{yesNo(consent.disclosureNotice)}</Tag></p>
    <p><strong>Per-participant consent:</strong> <Tag tone={consent.perParticipantConsent ? "success" : "warning"}>{yesNo(consent.perParticipantConsent)}</Tag></p>
    {!consent.disclosureNotice && grant.summary?.modes.listen && <p className="muted-detail" role="note">Caution: transcribing people without a notice can be unlawful where all parties must consent.</p>}
    {consent.perParticipantConsent && grant.summary?.modes.listen && <p className="muted-detail" role="note">Marketplace cannot ask each participant yet, so listening stays refused under this grant.</p>}
  </div>;
}

function GrantCard({ grant, onNotice }: { grant: LiveGrantView; onNotice: (notice: string) => void }) {
  const id = useId();
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["channel-live"] });
  const approve = useMutation({
    mutationFn: () => approveLiveGrant(grant.id, grant.digest),
    onSuccess: () => {
      onNotice(`Live-session grant ${grant.id} is active.`);
      refresh();
    },
  });
  const act = useMutation({
    mutationFn: (verb: "decline" | "revoke" | "pause" | "resume") => liveGrantAction(grant.id, verb),
    onSuccess: (result) => {
      onNotice(`Live-session grant ${grant.id}: ${result.grant.status}.`);
      refresh();
    },
  });
  const summary = grant.summary;
  const usage = grant.usage;
  const busy = approve.isPending || act.isPending;
  return <article className="live-grant" aria-labelledby={`${id}-title`}>
    <div className="section-heading">
      <div><h3 id={`${id}-title`}>{grant.channelLabel ?? grant.channelId} · <code>{grant.agentId}</code></h3><small className="muted-detail">{grant.id}</small></div>
      <Tag tone={STATUS_TONE[grant.status]}>{grant.status}</Tag>
    </div>
    <ConsentBlock grant={grant} />
    {summary && <dl className="live-summary">
      <dt>Modes</dt><dd>{modesText(summary.modes)}</dd>
      <dt>Where</dt><dd>{summary.target.huddleId ? <>huddle <code>{summary.target.huddleId}</code></> : <>huddles of channel <code>{summary.target.channelId}</code></>}</dd>
      <dt>Topic</dt><dd>{summary.topic}</dd>
      <dt>Forbidden terms</dt><dd>{summary.forbiddenTerms.length ? summary.forbiddenTerms.join(", ") : "none"}</dd>
      <dt>Session limit</dt><dd>{summary.maxSessionMinutes} min{usage ? ` (this session: ${usage.minutesInSession})` : ""}</dd>
      <dt>Minutes per day</dt><dd>{summary.maxDayMinutes}{usage ? ` (used: ${usage.minutesToday})` : ""}</dd>
      <dt>Provider minutes (cost cap)</dt><dd>{summary.providerMinutesCap} (used: {grant.providerMinutesUsed})</dd>
      <dt>Joins</dt><dd>{summary.caps.perDay} per day{summary.caps.perHour ? `, ${summary.caps.perHour} per hour` : ""}{summary.caps.minIntervalSeconds ? `, ${summary.caps.minIntervalSeconds} s apart` : ""}</dd>
      <dt>Expires</dt><dd>{formatWhen(summary.expires)}{grant.approvalExpiresAt ? ` (approval valid until ${formatWhen(grant.approvalExpiresAt)})` : ""}</dd>
    </dl>}
    <details>
      <summary>Canonical grant and digest</summary>
      <pre className="live-canonical" aria-label="Canonical grant JSON">{grant.canonical}</pre>
      <p>Digest <code>{grant.digest}</code></p>
      {grant.status === "proposed" && <p className="muted-detail">To approve in Buzz, reply in the channel with <code>{grant.approvalText}</code>.</p>}
    </details>
    {grant.approvedAt && <p className="muted-detail">Approved {formatWhen(grant.approvedAt)} via {grant.approvalSource}.</p>}
    {grant.reason && <p className="muted-detail">Reason: {grant.reason.replace(/_/gu, " ")}</p>}
    {(approve.error || act.error) && <InlineError error={(approve.error ?? act.error)!} />}
    <div className="dialog-actions">
      {grant.status === "proposed" && <>
        <Button size="small" tone="primary" disabled={busy} onClick={() => approve.mutate()}>{approve.isPending ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Approve this digest</Button>
        <Button size="small" disabled={busy} onClick={() => act.mutate("decline")}><XCircle size={14} />Decline</Button>
      </>}
      {grant.status === "active" && <Button size="small" disabled={busy} onClick={() => act.mutate("pause")}><Pause size={14} />Pause</Button>}
      {grant.status === "paused" && <Button size="small" disabled={busy} onClick={() => act.mutate("resume")}><Play size={14} />Resume</Button>}
      {["proposed", "active", "paused"].includes(grant.status) && <Button size="small" tone="danger" disabled={busy} onClick={() => act.mutate("revoke")}><CircleSlash size={14} />Revoke</Button>}
    </div>
  </article>;
}

function Transcript({ sessionId }: { sessionId: string }) {
  const transcript = useQuery({ queryKey: ["channel-live-transcript", sessionId], queryFn: () => getLiveTranscript(sessionId), retry: false });
  if (transcript.isLoading) return <span className="muted-detail">Loading transcript…</span>;
  if (transcript.error) return <InlineError error={transcript.error} />;
  const lines = transcript.data?.lines ?? [];
  if (!lines.length) return <p className="muted-detail">No transcript lines.</p>;
  return <ol className="plain-list live-transcript">{lines.map((line, index) => <li key={`${line.startedAt}-${index}`}>
    <small className="muted-detail">{formatWhen(line.startedAt)} · </small>
    {line.kind === "heard"
      ? <><code title={line.speaker?.pubkey}>{line.speaker?.npub.slice(0, 16) ?? "unknown"}…</code> (participant): </>
      : <><strong>Agent</strong>: </>}
    {line.purged ? <em>text removed after the retention period</em> : line.text || (line.clipSha256 ? <>approved clip <code>{line.clipSha256.slice(0, 16)}</code></> : "")}
    {line.flaggedTerms && line.flaggedTerms.length > 0 && <Tag tone="warning">forbidden term</Tag>}
  </li>)}</ol>;
}

function SessionRow({ session, onNotice }: { session: LiveSessionView; onNotice: (notice: string) => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const stop = useMutation({
    mutationFn: () => stopLiveSession(session.sessionId),
    onSuccess: () => {
      onNotice("The agent left the huddle.");
      void queryClient.invalidateQueries({ queryKey: ["channel-live"] });
    },
  });
  const live = session.status === "joining" || session.status === "joined";
  return <li className="live-session">
    <div>
      <strong>{session.channelLabel ?? session.channelId}</strong> · <code>{session.agentId}</code> · {modesText(session.modes)} · <Tag tone={live ? "success" : undefined}>{session.status}</Tag>
      <small className="muted-detail"> joined {formatWhen(session.joinedAt ?? session.startedAt)}{session.leftAt ? `, left ${formatWhen(session.leftAt)} (${(session.endReason ?? "").replace(/_/gu, " ")})` : ""} · listened {session.minutesListened} min · spoke {session.minutesSpoken} min</small>
    </div>
    <div className="dialog-actions">
      {live && <Button size="small" tone="danger" disabled={stop.isPending} onClick={() => stop.mutate()} aria-label={`Stop the session of ${session.agentId}`}><Square size={14} />Stop</Button>}
      <Button size="small" onClick={() => setOpen((value) => !value)}>{open ? "Hide transcript" : "Transcript"}</Button>
    </div>
    {stop.error && <InlineError error={stop.error} />}
    {open && <Transcript sessionId={session.sessionId} />}
  </li>;
}

/** Live voice: grant inbox, active sessions with Stop, transcripts, and the owner switch. */
export function LivePanel({ onNotice }: { onNotice: (notice: string) => void }) {
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: ["channel-live"], queryFn: getLiveOverview, retry: false, refetchInterval: 5000 });
  const [commandChannel, setCommandChannel] = useState("");
  const control = useMutation({
    mutationFn: (patch: { paused?: boolean; commandChannel?: string | null }) => updateLiveControl(patch),
    onSuccess: (result) => {
      onNotice(result.control.paused ? "Every live-session grant is paused." : "Live-session grants follow their own state.");
      void queryClient.invalidateQueries({ queryKey: ["channel-live"] });
    },
  });
  if (overview.isLoading) return null;
  if (overview.error || !overview.data) return null;
  const data = overview.data;
  const grants = data.grants.filter((grant) => ["proposed", "active", "paused"].includes(grant.status));
  const older = data.grants.filter((grant) => !["proposed", "active", "paused"].includes(grant.status));
  if (!data.buzzReady && data.grants.length === 0) return null;
  return <section className="channel-section" aria-labelledby="channel-live-heading">
    <div className="section-heading">
      <div><p className="eyebrow">Live voice</p><h2 id="channel-live-heading"><Mic size={16} aria-hidden="true" /> Huddle sessions</h2></div>
      <Button size="small" tone={data.control.paused ? "primary" : "danger"} disabled={control.isPending} onClick={() => control.mutate({ paused: !data.control.paused })}>
        {data.control.paused ? <><Play size={14} />Resume all grants</> : <><Pause size={14} />Pause all grants</>}
      </Button>
    </div>
    {data.control.paused && <p role="status"><Tag tone="warning">All live-session grants are paused</Tag></p>}
    {control.error && <InlineError error={control.error} />}
    <h3>Grants</h3>
    {grants.length ? grants.map((grant) => <GrantCard key={`${grant.id}-${grant.digest}`} grant={grant} onNotice={onNotice} />) : <p className="muted-detail">No open live-session grants.</p>}
    {older.length > 0 && <details><summary>Ended grants ({older.length})</summary>{older.map((grant) => <GrantCard key={`${grant.id}-${grant.digest}`} grant={grant} onNotice={onNotice} />)}</details>}
    <h3>Sessions</h3>
    {data.sessions.length ? <ul className="plain-list">{data.sessions.map((session) => <SessionRow key={session.sessionId} session={session} onNotice={onNotice} />)}</ul> : <p className="muted-detail">No huddle sessions yet.</p>}
    <form className="form-grid two" onSubmit={(event) => { event.preventDefault(); control.mutate({ commandChannel: commandChannel.trim() || null }); }}>
      <label>Owner command channel (Buzz channel id for signed <code>pause grants</code> / <code>resume grants</code>)
        <input value={commandChannel} onChange={(event) => setCommandChannel(event.target.value)} placeholder={data.control.commandChannel ?? "not set"} />
      </label>
      <div className="dialog-actions"><Button size="small" type="submit" disabled={control.isPending}>Save command channel</Button></div>
    </form>
  </section>;
}
