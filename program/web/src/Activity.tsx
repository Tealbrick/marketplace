import { useQuery } from "@tanstack/react-query";
import { Activity, LoaderCircle } from "lucide-react";
import { Tag } from "@tealbrick/ui";

import { getAudit } from "./api";
import { formatWhen, StatePanel, words } from "./ui";

const RECEIPT_EVENT = "marketplace.agent.outward.receipt";

function metadataOf(entry: Record<string, unknown>): Record<string, unknown> {
  const raw = entry.metadata;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** An outward action an Assistant agent ran without asking: what, where, with which (redacted) arguments. */
function ReceiptEntry({ entry }: { entry: Record<string, unknown> }) {
  const receipt = metadataOf(entry);
  const text = (value: unknown) => (typeof value === "string" && value ? value : "—");
  return (
    <article className="audit-receipt" data-testid="assistant-receipt">
      <span className="audit-line" />
      <div>
        <strong>Agent action without approval</strong>
        <code>{text(receipt.actionKey)}</code>
        <dl>
          <dt>Agent</dt><dd>{text(receipt.agentId)}</dd>
          <dt>Connector</dt><dd>{text(receipt.pluginId)}{receipt.account ? ` · ${String(receipt.account)}` : ""}</dd>
          <dt>Destination</dt><dd>{text(receipt.destination)}</dd>
          <dt>Arguments</dt><dd>{text(receipt.argumentsPreview)}</dd>
        </dl>
        <p>{formatWhen(receipt.at ?? entry.created_at ?? entry.createdAt)}</p>
      </div>
      <span className="audit-receipt__tags">
        <Tag tone="accent">Assistant</Tag>
        <Tag tone={receipt.status === "succeeded" ? "default" : "danger"}>{receipt.status === "succeeded" ? "Done" : "Failed"}</Tag>
      </span>
    </article>
  );
}

export function ActivityPage({ workspaceSlug }: { workspaceSlug: string }) {
  const audit = useQuery({ queryKey: ["audit", workspaceSlug], queryFn: () => getAudit(workspaceSlug), retry: false });
  if (audit.isLoading) return <div className="state-panel"><LoaderCircle className="spin" /><h2>Loading immutable evidence</h2></div>;
  if (audit.error) return <StatePanel error={audit.error} onRetry={() => void audit.refetch()} />;
  const entries = audit.data?.audit ?? [];
  return <section className="collection-page"><header><div><p className="eyebrow">Governed evidence</p><h1>Activity</h1><p>Lifecycle decisions, provider checks, bindings, and execution evidence recorded by the Program. Actions an Assistant agent ran without asking you are marked Assistant.</p></div><Tag>{entries.length} events</Tag></header>{entries.length ? <div className="audit-list">{entries.map((entry, index) => String(entry.event_type ?? entry.eventType) === RECEIPT_EVENT ? <ReceiptEntry key={String(entry.id ?? index)} entry={entry} /> : <article key={String(entry.id ?? index)}><span className="audit-line" /><div><strong>{words(String(entry.event_type ?? entry.eventType ?? "marketplace.event"))}</strong><code>{String(entry.plugin_id ?? entry.pluginId ?? "program")}</code><p>{String(entry.actor_id ?? entry.actorId ?? "system")} · {formatWhen(entry.created_at ?? entry.createdAt)}</p></div>{entry.rules_decision_id ? <Tag tone="success">{String(entry.rules_decision_id).startsWith("owner-governed:") ? "Owner approved" : "Rules recorded"}</Tag> : <Tag>Program event</Tag>}</article>)}</div> : <div className="collection-empty"><Activity /><h2>No activity recorded</h2><p>Governed lifecycle and execution operations will appear here.</p></div>}</section>;
}
