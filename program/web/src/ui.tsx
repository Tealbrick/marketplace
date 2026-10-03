import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@doppelganger/ui";

import { ApiError } from "./api";
import type { BrowserProviderHealth } from "./types";

export function words(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/gu, (character) => character.toUpperCase());
}

export function formatWhen(value: unknown) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function errorCopy(error: Error) {
  const status = error instanceof ApiError ? error.status : 0;
  if (status === 401) return { title: "Marketplace requires authentication", detail: "This route belongs to an internal service boundary. The browser has not been given its bearer credential." };
  if (status === 403) return { title: "Rules denied this operation", detail: error.message };
  if (status === 409) return { title: "Marketplace state conflicts", detail: error.message };
  if (status === 503) return { title: "A required authority is unavailable", detail: error.message };
  return { title: "Marketplace could not complete the request", detail: error.message };
}

export function statusTone(value: string): "success" | "danger" | "warning" | "accent" | "default" {
  if (["healthy", "connected", "ready", "installed", "complete", "active", "redeemed"].includes(value)) return "success";
  if (["blocked", "error", "denied", "failed", "revoked"].includes(value)) return "danger";
  if (["pending", "missing", "degraded", "authRequired", "expired"].includes(value)) return "warning";
  if (["available", "enabled"].includes(value)) return "accent";
  return "default";
}

export function StatePanel({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const copy = errorCopy(error);
  return <div className="state-panel" role="alert"><AlertTriangle size={23} /><h2>{copy.title}</h2><p>{copy.detail}</p><Button onClick={onRetry}><RefreshCw size={15} />Retry</Button></div>;
}

export function ProviderDot({ provider }: { provider: BrowserProviderHealth }) {
  return <span className={`provider-dot provider-dot--${provider.state}`} title={provider.detail} />;
}
