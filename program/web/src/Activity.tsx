import { useQuery } from "@tanstack/react-query";
import { Activity, LoaderCircle } from "lucide-react";
import { Tag } from "@tealbrick/ui";

import { getAudit } from "./api";
import { formatWhen, StatePanel, words } from "./ui";

export function ActivityPage({ workspaceSlug }: { workspaceSlug: string }) {
  const audit = useQuery({ queryKey: ["audit", workspaceSlug], queryFn: () => getAudit(workspaceSlug), retry: false });
  if (audit.isLoading) return <div className="state-panel"><LoaderCircle className="spin" /><h2>Loading immutable evidence</h2></div>;
  if (audit.error) return <StatePanel error={audit.error} onRetry={() => void audit.refetch()} />;
  const entries = audit.data?.audit ?? [];
  return <section className="collection-page"><header><div><p className="eyebrow">Governed evidence</p><h1>Activity</h1><p>Lifecycle decisions, provider checks, bindings, and execution evidence recorded by the Program.</p></div><Tag>{entries.length} events</Tag></header>{entries.length ? <div className="audit-list">{entries.map((entry, index) => <article key={String(entry.id ?? index)}><span className="audit-line" /><div><strong>{words(String(entry.event_type ?? entry.eventType ?? "marketplace.event"))}</strong><code>{String(entry.plugin_id ?? entry.pluginId ?? "program")}</code><p>{String(entry.actor_id ?? entry.actorId ?? "system")} · {formatWhen(entry.created_at ?? entry.createdAt)}</p></div>{entry.rules_decision_id ? <Tag tone="success">{String(entry.rules_decision_id).startsWith("owner-governed:") ? "Owner approved" : "Rules recorded"}</Tag> : <Tag>Program event</Tag>}</article>)}</div> : <div className="collection-empty"><Activity /><h2>No activity recorded</h2><p>Governed lifecycle and execution operations will appear here.</p></div>}</section>;
}
