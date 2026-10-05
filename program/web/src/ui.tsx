import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@tealbrick/ui";

import { errorCopy } from "./copy";
import type { BrowserProviderHealth } from "./types";

export { errorCopy, statusLabel, words } from "./copy";

export function formatWhen(value: unknown) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function statusTone(value: string): "success" | "danger" | "warning" | "accent" | "default" {
  if (["healthy", "connected", "ready", "installed", "complete", "active", "redeemed"].includes(value)) return "success";
  if (["blocked", "error", "denied", "failed", "revoked"].includes(value)) return "danger";
  if (["pending", "missing", "degraded", "authRequired", "expired"].includes(value)) return "warning";
  if (["available", "enabled"].includes(value)) return "accent";
  return "default";
}

export function ErrorReference({ reference }: { reference: string | null }) {
  return reference ? <small className="error-reference">Reference: <code>{reference}</code></small> : null;
}

export function InlineError({ error }: { error: Error }) {
  const copy = errorCopy(error);
  return <p className="inline-error" role="alert"><AlertTriangle size={14} /><span><strong>{copy.title}.</strong> {copy.detail} <ErrorReference reference={copy.reference} /></span></p>;
}

export function StatePanel({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const copy = errorCopy(error);
  return <div className="state-panel" role="alert"><AlertTriangle size={23} /><h2>{copy.title}</h2><p>{copy.detail}</p><ErrorReference reference={copy.reference} />{!copy.sessionEnded && <Button onClick={onRetry}><RefreshCw size={15} />Retry</Button>}</div>;
}

export function ProviderDot({ provider }: { provider: BrowserProviderHealth }) {
  // A provider that was never set up is optional, not failing: show it neutral.
  const tone = provider.configured ? provider.state : "unset";
  return <span className={`provider-dot provider-dot--${tone}`} title={provider.detail} />;
}
