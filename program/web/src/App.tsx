import { useDeferredValue, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, Boxes, CheckCircle2, Filter, KeyRound, LoaderCircle, PackageCheck, Plug, RefreshCw, Search, Settings, ShieldCheck, X } from "lucide-react";
import { BrandMark, Button, Field, IconButton, Tag } from "@doppelganger/ui";

import { ActivityPage } from "./Activity";
import { AgentGrantsPage } from "./AgentGrants";
import { revokeAgentGrant } from "./agent-grants-api";
import { getBootstrap, getCardDetail, getCardSummaries, getLiveness, getOperatorSession, getRuntimeHealth, unlockOperator } from "./api";
import { CatalogRow, ConfirmDialog, type ConfirmState, PluginWorkspace } from "./Catalog";
import { ConnectionsPage } from "./Connections";
import { SettingsDialog } from "./Settings";
import type { AgentGrantSummary, BrowserProviderHealth, OperatorSession, RulesConnectionStatus } from "./types";
import { RULES_STATUS_COPY, SESSION_ENDED_COPY } from "./copy";
import { InlineError, ProviderDot, StatePanel, words } from "./ui";

type Section = "catalog" | "installed" | "connections" | "grants" | "activity";
const PAGE_SIZE = 60;

type SignedOutReason = "ended" | "signedOut" | null;

function UnlockScreen({ session, reason, onUnlocked }: { session: OperatorSession; reason: SignedOutReason; onUnlocked: () => void }) {
  const [accessToken, setAccessToken] = useState("");
  const unlock = useMutation({
    mutationFn: () => unlockOperator(accessToken),
    onSuccess: () => {
      setAccessToken("");
      onUnlocked();
    },
  });
  const title = reason === "ended" ? "Your session ended" : reason === "signedOut" ? "You're signed out" : "Open Marketplace from Teal Brick Portal";
  const lede = reason === "ended" ? SESSION_ENDED_COPY : reason === "signedOut" ? "To continue, relaunch Marketplace from Teal Brick Portal." : "Marketplace opens from Teal Brick Portal. Relaunch it there to continue.";
  return <main className="marketplace-auth-screen">
    <section className="auth-brand"><BrandMark /><p className="eyebrow">Teal Brick · Marketplace</p><h1>Connect the tools your team and agents rely on.</h1><p className="auth-lede">Browse connectors, install the ones you need, and decide which agents can use them. Every change is checked against your organization's approval rules.</p><div className="auth-proof"><div><ShieldCheck size={18} /><span><strong>Private by default</strong>Nothing in your catalog is visible until you're signed in.</span></div><div><KeyRound size={18} /><span><strong>Approved changes only</strong>Installs and connections follow your organization's rules.</span></div><div><Plug size={18} /><span><strong>Keys stay on the server</strong>Provider keys are never sent to your browser.</span></div></div></section>
    <section className="auth-card"><h2>{title}</h2><p className="auth-card__lede">{lede}</p>
      {session.configured ? <details className="operator-recovery"><summary>Operator recovery</summary><form onSubmit={(event) => { event.preventDefault(); unlock.mutate(); }}><p>For administrators: sign in with the access token set up for this Marketplace.</p><Field label="Operator access token"><input autoComplete="current-password" type="password" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} required /></Field>{unlock.error && <InlineError error={unlock.error} />}<Button tone="primary" type="submit" disabled={unlock.isPending || !accessToken.trim()}>{unlock.isPending ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}Unlock Marketplace</Button></form></details> : <div className="auth-warning"><AlertTriangle size={18} /><span>Sign-in isn't set up for this Marketplace yet. Ask your administrator to finish setup, then relaunch from Teal Brick Portal.</span></div>}
    </section>
  </main>;
}

const DOT_FOR_TONE = { success: "healthy", warning: "degraded", danger: "missing" } as const;

export function RulesStatusDot({ status }: { status: RulesConnectionStatus | undefined }) {
  const copy = status ? RULES_STATUS_COPY[status] : null;
  return <span className={`provider-dot provider-dot--${copy ? DOT_FOR_TONE[copy.tone] : "unknown"}`} title={copy?.detail ?? "Checking approvals…"} />;
}

function MarketplaceNav({ section, onSection, providers, rules, version, onSettings }: { section: Section; onSection: (section: Section) => void; providers?: Record<string, BrowserProviderHealth>; rules?: RulesConnectionStatus; version?: string; onSettings: () => void }) {
  const entries: Array<{ id: Section; label: string; icon: typeof Boxes }> = [
    { id: "catalog", label: "Catalog", icon: Boxes },
    { id: "installed", label: "Installed", icon: PackageCheck },
    { id: "connections", label: "Connections", icon: Plug },
    { id: "grants", label: "Agent grants", icon: ShieldCheck },
    { id: "activity", label: "Activity", icon: Activity },
  ];
  return (
    <aside className="navigation-rail">
      <header className="brand-lockup"><BrandMark /><span><strong>Marketplace</strong><small>Teal Brick capabilities</small></span></header>
      <nav aria-label="Marketplace sections">{entries.map(({ id, label, icon: Icon }) => <button className={section === id ? "is-active" : ""} key={id} onClick={() => onSection(id)}><Icon size={17} />{label}</button>)}</nav>
      <section className="provider-summary">
        <p className="eyebrow">Status</p>
        <div className="rules-status-row" title={rules ? RULES_STATUS_COPY[rules].detail : undefined}><RulesStatusDot status={rules} /><span>Approvals</span><small>{rules ? RULES_STATUS_COPY[rules].label.toLowerCase() : "checking"}</small></div>
        {providers ? Object.entries(providers).map(([name, provider]) => <div key={name}><ProviderDot provider={provider} /><span>{words(name)}</span><small>{provider.reachable ? "reachable" : provider.configured ? "configured" : "not configured"}</small></div>) : <p className="muted">Loading provider state…</p>}
      </section>
      <footer><span>Marketplace{version && version !== "unknown" ? ` ${version}` : ""}</span><IconButton aria-label="Open settings" onClick={onSettings}><Settings size={16} /></IconButton></footer>
    </aside>
  );
}

function ProgramState({ online, rules }: { online: boolean | null; rules?: RulesConnectionStatus }) {
  const label = online === false ? "Offline" : online ? "Online" : "Checking…";
  const tone = online === false ? "danger" : online ? "success" : "unknown";
  return <span className="program-state-group">
    <span className={`program-state program-state--${tone}`} role="status" title={online === false ? "Marketplace isn't responding. Check your connection and try again." : undefined}><span />{label}</span>
    {online !== false && rules && <span className={`program-state program-state--${RULES_STATUS_COPY[rules].tone}`} title={RULES_STATUS_COPY[rules].detail}><span />Approvals {RULES_STATUS_COPY[rules].label.toLowerCase()}</span>}
  </span>;
}

export function App() {
  const queryClient = useQueryClient();
  const [section, setSection] = useState<Section>("catalog");
  const [workspaceSlug, setWorkspaceSlug] = useState("");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [source, setSource] = useState("all");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [signedOutReason, setSignedOutReason] = useState<SignedOutReason>(null);
  const installed = section === "installed";

  const operatorSession = useQuery({ queryKey: ["marketplace-session"], queryFn: getOperatorSession, retry: false });
  const authenticated = operatorSession.data?.session.authenticated === true;
  const bootstrap = useQuery({ queryKey: ["bootstrap"], queryFn: getBootstrap, enabled: authenticated, retry: false });
  const liveness = useQuery({ queryKey: ["liveness"], queryFn: getLiveness, enabled: authenticated, retry: false, refetchInterval: 30_000 });
  const runtimeHealth = useQuery({ queryKey: ["runtime-health"], queryFn: getRuntimeHealth, enabled: authenticated, retry: false, refetchInterval: 30_000 });
  const cards = useQuery({
    queryKey: ["cards", workspaceSlug, deferredSearch, source, installed, offset],
    queryFn: () => getCardSummaries({ workspaceSlug, search: deferredSearch, source, installed, offset, limit: PAGE_SIZE }),
    retry: false,
    enabled: authenticated && Boolean(workspaceSlug),
    placeholderData: (previous) => previous,
  });
  const detail = useQuery({
    queryKey: ["card-detail", workspaceSlug, selectedId],
    queryFn: () => getCardDetail(selectedId!, workspaceSlug),
    enabled: authenticated && Boolean(workspaceSlug) && Boolean(selectedId) && (section === "catalog" || section === "installed"),
    retry: false,
  });

  useEffect(() => { setOffset(0); }, [workspaceSlug, deferredSearch, source, installed]);
  useEffect(() => {
    const principalScope = operatorSession.data?.session.principal?.organizationId;
    setWorkspaceSlug(principalScope ?? "");
  }, [operatorSession.data?.session.principal?.organizationId]);
  const clearAuthenticatedData = () => {
    queryClient.removeQueries({ predicate: ({ queryKey }) => queryKey[0] !== "marketplace-session" });
    setWorkspaceSlug("");
    setSelectedId(null);
    setSettingsOpen(false);
    setConfirm(null);
    setNotice(null);
  };
  useEffect(() => {
    const expired = () => {
      setSignedOutReason("ended");
      clearAuthenticatedData();
      void queryClient.invalidateQueries({ queryKey: ["marketplace-session"] });
    };
    window.addEventListener("marketplace-auth-expired", expired);
    return () => window.removeEventListener("marketplace-auth-expired", expired);
  }, [queryClient]);
  useEffect(() => {
    const items = cards.data?.items ?? [];
    if (!selectedId || !items.some((card) => card.pluginId === selectedId)) setSelectedId(items[0]?.pluginId ?? null);
  }, [cards.data?.items, selectedId]);

  const refresh = () => { setNotice(null); void cards.refetch(); if (selectedId) void detail.refetch(); void queryClient.invalidateQueries({ queryKey: ["agent-grants", workspaceSlug] }); void liveness.refetch(); void runtimeHealth.refetch(); };

  const requestRevoke = (grant: AgentGrantSummary) => setConfirm({
    title: `Revoke access for ${grant.agentId}?`,
    detail: `${grant.agentId} will no longer be able to use ${grant.resourceRef}. The connected account stays connected; granting access again needs approval in Teal Brick Portal.`,
    label: "Revoke grant",
    danger: true,
    run: () => revokeAgentGrant(grant.id),
  });

  if (operatorSession.isLoading) return <main className="boot-state"><BrandMark /><LoaderCircle className="spin" /><span>Checking your session…</span></main>;
  if (operatorSession.error) return <main className="boot-state"><StatePanel error={operatorSession.error} onRetry={() => void operatorSession.refetch()} /></main>;
  if (!authenticated) return <UnlockScreen reason={signedOutReason} session={operatorSession.data?.session ?? { configured: false, authenticated: false, mode: "unconfigured", principal: null, csrfToken: null, expiresAt: null }} onUnlocked={() => { setSignedOutReason(null); void queryClient.invalidateQueries({ queryKey: ["marketplace-session"] }); }} />;
  if (bootstrap.isLoading) return <main className="boot-state"><BrandMark /><LoaderCircle className="spin" /><span>Opening Marketplace…</span></main>;
  if (bootstrap.error) return <main className="boot-state"><StatePanel error={bootstrap.error} onRetry={() => void bootstrap.refetch()} /></main>;
  if (!workspaceSlug) return <main className="boot-state"><BrandMark /><LoaderCircle className="spin" /><span>Loading your organization…</span></main>;

  return <main className="app-shell">
    <MarketplaceNav section={section} onSection={setSection} providers={cards.data?.providers} rules={runtimeHealth.data?.rules} version={bootstrap.data?.program.version} onSettings={() => setSettingsOpen(true)} />
    <section className="application-frame">
      <header className="topbar"><div className="verified-scope"><span className="eyebrow">Organization</span><code>{workspaceSlug}</code></div><div><ProgramState online={liveness.isError ? false : liveness.data ? true : null} rules={runtimeHealth.data?.rules} /><Button size="small" onClick={refresh}><RefreshCw size={14} />Refresh</Button><IconButton className="topbar-settings" aria-label="Open settings" onClick={() => setSettingsOpen(true)}><Settings size={16} /></IconButton></div></header>
      {section === "grants" ? <AgentGrantsPage workspaceSlug={workspaceSlug} onRevoke={requestRevoke} /> : cards.error ? <StatePanel error={cards.error} onRetry={() => void cards.refetch()} /> : section === "connections" && cards.data ? <ConnectionsPage connections={cards.data.connections} providers={cards.data.providers} onChanged={refresh} /> : section === "activity" ? <ActivityPage workspaceSlug={workspaceSlug} /> : installed && cards.data && cards.data.filteredTotal === 0 && !deferredSearch && source === "all" ? <section className="collection-page"><div className="collection-empty"><PackageCheck size={28} /><h2>Nothing installed yet</h2><p>Install connectors from the catalog to make them available to your workspace and agents.</p><Button tone="primary" onClick={() => setSection("catalog")}><Boxes size={15} />Browse the catalog</Button></div></section> : <div className="catalog-layout">
        <aside className="catalog-index"><div className="index-heading"><div><p className="eyebrow">{installed ? "Your workspace" : "Catalog"}</p><h2>{installed ? "Installed" : "Discover"}</h2></div><Tag>{cards.data?.filteredTotal ?? 0}</Tag></div><label className="search-box"><Search size={15} /><input aria-label="Search catalog" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search providers and tools…" /></label><label className="source-filter"><Filter size={14} /><select aria-label="Filter by source" value={source} onChange={(event) => setSource(event.target.value)}><option value="all">All sources</option>{cards.data?.sources.map((entry) => <option key={entry} value={entry}>{words(entry)}</option>)}</select></label><div className="catalog-list">{cards.isLoading ? <div className="list-loading"><LoaderCircle className="spin" />Loading catalog…<small>Showing up to {PAGE_SIZE} at a time.</small></div> : cards.data?.items.length ? cards.data.items.map((card) => <CatalogRow key={card.pluginId} card={card} selected={selectedId === card.pluginId} onSelect={() => setSelectedId(card.pluginId)} />) : <div className="list-empty">No matching capabilities.</div>}</div>{cards.data && cards.data.filteredTotal > PAGE_SIZE && <footer className="index-footer"><Button size="small" disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}>Previous</Button><span>{offset + 1}–{Math.min(offset + PAGE_SIZE, cards.data.filteredTotal)} of {cards.data.filteredTotal}</span><Button size="small" disabled={!cards.data.hasMore} onClick={() => setOffset((value) => value + PAGE_SIZE)}>Next</Button></footer>}</aside>
        <section className="primary-workspace">{detail.error ? <StatePanel error={detail.error} onRetry={() => void detail.refetch()} /> : <PluginWorkspace card={detail.data?.card ?? null} loading={detail.isLoading && Boolean(selectedId)} workspaceSlug={workspaceSlug} onConfirm={setConfirm} onRefresh={refresh} />}</section>
      </div>}
      {notice && <div className="toast" role="status"><CheckCircle2 size={16} />{notice}<button aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={14} /></button></div>}
    </section>
    <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} onSuccess={() => { setNotice("Done — your change was approved and saved."); refresh(); }} />
    <SettingsDialog health={{ online: liveness.isError ? false : liveness.data ? true : null, rules: runtimeHealth.data?.rules }} open={settingsOpen} onOpenChange={setSettingsOpen} bootstrap={bootstrap.data!} workspaceSlug={workspaceSlug} session={operatorSession.data!.session} onLogout={() => { setSignedOutReason("signedOut"); clearAuthenticatedData(); void queryClient.invalidateQueries({ queryKey: ["marketplace-session"] }); }} />
  </main>;
}
