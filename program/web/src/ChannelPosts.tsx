import { useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, CheckCircle2, Download, ExternalLink, LoaderCircle, ReceiptText, Trash2, XCircle } from "lucide-react";
import { Button, Tag } from "@tealbrick/ui";

import type { ConfirmState } from "./Catalog";
import { exportChannelReceipts, purgeChannelReceipts, resolveChannelPost } from "./channels-api";
import { digestPrefix, providerLabel, RECEIPT_STATUS_LABEL, receiptTone, safeHttpsUrl } from "./channels-model";
import { DestinationTitle } from "./ChannelForms";
import { UNCERTAIN_RESOLVE_HINT } from "./copy";
import type { ChannelReceipt, ChannelReceiptExport, ChannelView, UncertainChannelPost } from "./types";
import { formatWhen, InlineError } from "./ui";

/** Provider links open in a new tab; only https links are rendered as links. */
export function ReceiptLinks({ urls }: { urls: string[] }) {
  if (!urls.length) return null;
  return <span className="receipt-links">{urls.map((url, index) => {
    const safe = safeHttpsUrl(url);
    return safe
      ? <a key={`${url}-${index}`} href={safe} target="_blank" rel="noopener noreferrer"><ExternalLink size={12} aria-hidden="true" />Open post{urls.length > 1 ? ` ${index + 1}` : ""}<span className="visually-hidden"> (opens in a new tab)</span></a>
      : <code key={`${url}-${index}`}>{url}</code>;
  })}</span>;
}

/** One receipt: status, links, authority, fallback note. All text is plain. */
export function ReceiptSummary({ receipt, channel }: { receipt: ChannelReceipt; channel?: ChannelView }) {
  return <div className="receipt-summary" aria-label="Receipt">
    <Tag tone={receiptTone(receipt.status)}>{RECEIPT_STATUS_LABEL[receipt.status] ?? receipt.status}</Tag>
    <span>{channel ? channel.label : providerLabel(receipt.provider)}{receipt.sentAt ? ` · sent ${formatWhen(receipt.sentAt)}` : ""}</span>
    <ReceiptLinks urls={receipt.resultUrls} />
    {receipt.fallback && <span className="receipt-fallback">Fallback applied: {receipt.fallback}</span>}
    <code title={receipt.digest}>digest {digestPrefix(receipt.digest)}</code>
  </div>;
}

function UncertainRow({ post, channel, onNotice }: { post: UncertainChannelPost; channel: ChannelView | undefined; onNotice: (notice: string) => void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const resolve = useMutation({
    mutationFn: (status: "sent" | "failed") => resolveChannelPost(post.id, status),
    onSuccess: (_result, status) => { setOpen(false); onNotice(status === "sent" ? "Marked the post as sent. It counts toward the channel limits." : "Marked the post as failed. The agent can post it again."); },
  });
  const destinationUrl = safeHttpsUrl(channel?.destination.url);
  return <article className="uncertain-post" aria-labelledby={`${id}-title`}>
    <div>
      <strong id={`${id}-title`}>{channel?.label ?? post.channelId}</strong>
      <p>From <code>{post.agentId}</code> · {formatWhen(post.updatedAt)} · digest <code title={post.digest}>{digestPrefix(post.digest)}</code>{post.reason ? ` · ${post.reason.replace(/_/gu, " ")}` : ""}</p>
    </div>
    {!open && <Button size="small" onClick={() => setOpen(true)} aria-expanded={false}>Resolve</Button>}
    {open && <div className="resolve-panel" role="group" aria-label="Resolve uncertain post">
      <p className="contract-gap"><AlertTriangle size={16} aria-hidden="true" /><span>{UNCERTAIN_RESOLVE_HINT}</span></p>
      {channel && <p className="muted-detail">Destination: <DestinationTitle destination={channel.destination} />{destinationUrl && <> · <a href={destinationUrl} target="_blank" rel="noopener noreferrer">Open destination<span className="visually-hidden"> (opens in a new tab)</span></a></>}</p>}
      {resolve.error && <InlineError error={resolve.error} />}
      <div className="dialog-actions">
        <Button size="small" tone="primary" disabled={resolve.isPending} onClick={() => resolve.mutate("sent")}>{resolve.isPending && resolve.variables === "sent" ? <LoaderCircle className="spin" size={14} /> : <CheckCircle2 size={14} />}I see it: mark sent</Button>
        <Button size="small" disabled={resolve.isPending} onClick={() => resolve.mutate("failed")}>{resolve.isPending && resolve.variables === "failed" ? <LoaderCircle className="spin" size={14} /> : <XCircle size={14} />}It isn't there: mark failed</Button>
        <Button size="small" disabled={resolve.isPending} onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>}
  </article>;
}

export function UncertainPosts({ posts, channels, onNotice }: { posts: UncertainChannelPost[]; channels: ChannelView[]; onNotice: (notice: string) => void }) {
  if (!posts.length) return null;
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  return <section className="channel-section uncertain-posts" aria-labelledby="uncertain-heading">
    <div className="section-heading"><div><p className="eyebrow">Needs you</p><h2 id="uncertain-heading">Delivery uncertain</h2></div><Tag tone="warning" aria-label={`${posts.length} uncertain posts`}>{posts.length}</Tag></div>
    <p className="section-copy">The request reached the provider, but no answer came back. These posts count toward the limits and can't be sent again until you resolve them.</p>
    {posts.map((post) => <UncertainRow key={post.id} post={post} channel={byId.get(post.channelId)} onNotice={onNotice} />)}
  </section>;
}

function download(name: string, content: string) {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function ReceiptRow({ receipt, channel }: { receipt: ChannelReceiptExport; channel: ChannelView | undefined }) {
  return <article className="receipt-row">
    <div className="receipt-row__head">
      <Tag tone={receiptTone(receipt.status)}>{RECEIPT_STATUS_LABEL[receipt.status] ?? receipt.status}</Tag>
      <strong>{channel?.label ?? receipt.channelId}</strong>
      <span className="muted-detail">{providerLabel(receipt.provider)} · <code>{receipt.agentId}</code> · {formatWhen(receipt.sentAt ?? receipt.createdAt)}</span>
    </div>
    <div className="receipt-row__meta">
      <ReceiptLinks urls={receipt.resultUrls} />
      {receipt.fallback && <span className="receipt-fallback">Fallback applied: {receipt.fallback}</span>}
      {receipt.authority && <span>Authority <code>{receipt.authority}</code></span>}
      <span>Digest <code title={receipt.digest}>{digestPrefix(receipt.digest)}</code></span>
    </div>
    {receipt.detail && <p className="muted-detail receipt-detail">{receipt.detail}</p>}
    {receipt.text && <details className="receipt-text"><summary>Posted text</summary><pre className="plain-text">{receipt.text}</pre></details>}
  </article>;
}

const STATUS_FILTERS = ["all", "sent", "failed", "uncertain", "skipped", "cancelled", "expired"] as const;

/** Scheduled posts (pending receipts) and the receipt record, with export and purge. */
export function ReceiptsSection({ channels, onConfirm, onNotice }: { channels: ChannelView[]; onConfirm: (state: NonNullable<ConfirmState>) => void; onNotice: (notice: string) => void }) {
  const id = useId();
  const [channelId, setChannelId] = useState("");
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const [olderThanDays, setOlderThanDays] = useState("90");
  const receipts = useQuery({ queryKey: ["channel-receipts", channelId], queryFn: () => exportChannelReceipts({ channelId: channelId || undefined, limit: 200 }), retry: false, refetchInterval: 60_000 });
  const exporter = useMutation({
    mutationFn: () => exportChannelReceipts({ channelId: channelId || undefined, limit: 1000 }),
    onSuccess: (result) => {
      const saved = download(`channel-receipts-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(result.receipts, null, 2));
      onNotice(saved ? `Exported ${result.receipts.length} receipts.` : "Your browser can't save files here.");
    },
  });
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const all = receipts.data?.receipts ?? [];
  const scheduled = all.filter((receipt) => receipt.status === "pending");
  const settled = all.filter((receipt) => receipt.status !== "pending" && (status === "all" || receipt.status === status));
  const days = Number(olderThanDays);
  const daysValid = Number.isInteger(days) && days >= 0 && days <= 3650;
  return <section className="channel-section" aria-labelledby={`${id}-heading`}>
    <div className="section-heading"><div><p className="eyebrow">What was posted</p><h2 id={`${id}-heading`}>Scheduled posts and receipts</h2></div><ReceiptText size={18} aria-hidden="true" /></div>
    <div className="receipt-filters">
      <label>Channel<select value={channelId} onChange={(event) => setChannelId(event.target.value)}><option value="">All channels</option>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.label}</option>)}</select></label>
      <label>Status<select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>{STATUS_FILTERS.map((entry) => <option key={entry} value={entry}>{entry === "all" ? "All statuses" : RECEIPT_STATUS_LABEL[entry]}</option>)}</select></label>
      <Button size="small" onClick={() => exporter.mutate()} disabled={exporter.isPending}>{exporter.isPending ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}Export receipts</Button>
    </div>
    {exporter.error && <InlineError error={exporter.error} />}
    {receipts.error ? <InlineError error={receipts.error} /> : receipts.isLoading ? <p className="muted">Loading receipts…</p> : <>
      <h3 className="subsection-title"><CalendarClock size={15} aria-hidden="true" /> Scheduled ({scheduled.length})</h3>
      {scheduled.length ? <div className="receipt-list">{scheduled.map((receipt) => <ReceiptRow key={receipt.postId} receipt={receipt} channel={byId.get(receipt.channelId)} />)}</div> : <p className="muted-detail">No scheduled posts. Posts waiting for your approval are listed under Approvals.</p>}
      <h3 className="subsection-title"><ReceiptText size={15} aria-hidden="true" /> Receipts ({settled.length})</h3>
      {settled.length ? <div className="receipt-list">{settled.map((receipt) => <ReceiptRow key={receipt.postId} receipt={receipt} channel={byId.get(receipt.channelId)} />)}</div> : <p className="muted-detail">No receipts match.</p>}
    </>}
    <div className="purge-row">
      <label>Remove receipts older than (days)<input type="number" min={0} max={3650} value={olderThanDays} aria-invalid={daysValid ? undefined : true} onChange={(event) => setOlderThanDays(event.target.value)} /></label>
      <Button size="small" tone="danger" disabled={!daysValid} onClick={() => onConfirm({
        title: `Remove receipts older than ${days} days?`,
        detail: "Receipts keep the posted text for your records. Removed receipts can't be restored. The audit trail keeps only the payload hash.",
        label: "Remove receipts",
        danger: true,
        run: async () => {
          const result = await purgeChannelReceipts(days);
          onNotice(`Removed ${result.purged} ${result.purged === 1 ? "receipt" : "receipts"}.`);
          return result;
        },
      })}><Trash2 size={14} />Purge</Button>
    </div>
  </section>;
}
