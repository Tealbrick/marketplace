import { useDeferredValue, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, Boxes, CheckCircle2, Filter, KeyRound, LoaderCircle, PackageCheck, Plug, RefreshCw, Search, Settings, ShieldCheck, X } from "lucide-react";
import { BrandMark, Button, Field, IconButton, Tag } from "@doppelganger/ui";

import { ActivityPage } from "./Activity";
import { AgentGrantsPage } from "./AgentGrants";
import { revokeAgentGrant } from "./agent-grants-api";
import { getBootstrap, getCardDetail, getCardSummaries, getOperatorSession, unlockOperator } from "./api";
import { CatalogRow, ConfirmDialog, type ConfirmState, PluginWorkspace } from "./Catalog";
import { ConnectionsPage } from "./Connections";
import { SettingsDialog } from "./Settings";
import type { AgentGrantSummary, BrowserProviderHealth, OperatorSession } from "./types";
import { ProviderDot, StatePanel, words } from "./ui";

type Section = "catalog" | "installed" | "connections" | "grants" | "activity";
const PAGE_SIZE = 60;

function UnlockScreen({ session, onUnlocked }: { session: OperatorSession; onUnlocked: () => void }) {
  const [accessToken, setAccessToken] = useState("");
  const unlock = useMutation({
    mutationFn: () => unlockOperator(accessToken),
    onSuccess: () => {
      setAccessToken("");
      onUnlocked();
    },
  });
  return <main className="marketplace-auth-screen"><section className="auth-brand"><BrandMark /><p className="eyebrow">Doppelganger · Marketplace authority</p><h1>One accountable operator boundary for the capability supply chain.</h1><p className="auth-lede">Catalog data, provider settings, installation state, and execution evidence stay private until this browser receives a short-lived operator session.</p><div className="auth-proof"><div><ShieldCheck size={18} /><span><strong>Fail closed</strong>No catalog or provider state is public.</span></div><div><KeyRound size={18} /><span><strong>Session bound</strong>Writes require the HttpOnly session and CSRF proof.</span></div><div><Plug size={18} /><span><strong>Service separated</strong>Agents and miniapps use an internal bearer, never this operator token.</span></div></div></section><section className="auth-card"><p className="folio">00 / ACCESS</p><h2>{session.configured ? "Unlock Marketplace" : "Operator access is not configured"}</h2>{session.configured ? <form onSubmit={(event) => { event.preventDefault(); unlock.mutate(); }}><p>Use the access token provisioned by the Marketplace Program owner.</p><Field label="Operator access token"><input autoFocus autoComplete="current-password" type="password" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} required /></Field>{unlock.error && <p className="inline-error"><AlertTriangle size={15} />{unlock.error.message}</p>}<Button tone="primary" type="submit" disabled={unlock.isPending || !accessToken.trim()}>{unlock.isPending ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}Unlock Marketplace</Button></form> : <div className="auth-warning"><AlertTriangle size={18} /><span>Set <code>MARKETPLACE_OPERATOR_ACCESS_TOKEN</code> to a unique secret of at least 16 characters, then restart the Program.</span></div>}</section></main>;
}

function MarketplaceNav({ section, onSection, providers, onSettings }: { section: Section; onSection: (section: Section) => void; providers?: Record<string, BrowserProviderHealth>; onSettings: () => void }) {
  const entries: Array<{ id: Section; label: string; icon: typeof Boxes }> = [
    { id: "catalog", label: "Catalog", icon: Boxes },
    { id: "installed", label: "Installed", icon: PackageCheck },
    { id: "connections", label: "Connections", icon: Plug },
    { id: "grants", label: "Agent grants", icon: ShieldCheck },
    { id: "activity", label: "Activity", icon: Activity },
  ];
  return (
    <aside className="navigation-rail">
      <header className="brand-lockup"><BrandMark /><span><strong>Marketplace</strong><small>Doppelganger capabilities</small></span></header>
      <nav aria-label="Marketplace sections">{entries.map(({ id, label, icon: Icon }) => <button className={section === id ? "is-active" : ""} key={id} onClick={() => onSection(id)}><Icon size={17} />{label}</button>)}</nav>
      <section className="provider-summary">
        <p className="eyebrow">Provider fabric</p>
        {providers ? Object.entries(providers).map(([name, provider]) => <div key={name}><ProviderDot provider={provider} /><span>{words(name)}</span><small>{provider.reachable ? "reachable" : provider.configured ? "configured" : "not configured"}</small></div>) : <p className="muted">Loading provider state…</p>}
      </section>
      <footer><span>Program-owned catalog</span><IconButton aria-label="Open settings" onClick={onSettings}><Settings size={16} /></IconButton></footer>
    </aside>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [section, setSection] = useState<Section>("catalog");
  const [workspaceSlug, setWorkspaceSlug] = useState("default");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [source, setSource] = useState("all");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const installed = section === "installed";

  const operatorSession = useQuery({ queryKey: ["marketplace-session"], queryFn: getOperatorSession, retry: false });
  const authenticated = operatorSession.data?.session.authenticated === true;
  const bootstrap = useQuery({ queryKey: ["bootstrap"], queryFn: getBootstrap, enabled: authenticated, retry: false });
  const cards = useQuery({
    queryKey: ["cards", workspaceSlug, deferredSearch, source, installed, offset],
    queryFn: () => getCardSummaries({ workspaceSlug, search: deferredSearch, source, installed, offset, limit: PAGE_SIZE }),
    retry: false,
    enabled: authenticated,
    placeholderData: (previous) => previous,
  });
  const detail = useQuery({
    queryKey: ["card-detail", workspaceSlug, selectedId],
    queryFn: () => getCardDetail(selectedId!, workspaceSlug),
    enabled: authenticated && Boolean(selectedId) && (section === "catalog" || section === "installed"),
    retry: false,
  });

  useEffect(() => { setOffset(0); }, [workspaceSlug, deferredSearch, source, installed]);
  useEffect(() => {
    const principalScope = operatorSession.data?.session.principal?.organizationId;
    if (principalScope) setWorkspaceSlug(principalScope);
  }, [operatorSession.data?.session.principal?.organizationId]);
  useEffect(() => {
    const expired = () => void queryClient.invalidateQueries({ queryKey: ["marketplace-session"] });
    window.addEventListener("marketplace-auth-expired", expired);
    return () => window.removeEventListener("marketplace-auth-expired", expired);
  }, [queryClient]);
  useEffect(() => {
    const items = cards.data?.items ?? [];
    if (!selectedId || !items.some((card) => card.pluginId === selectedId)) setSelectedId(items[0]?.pluginId ?? null);
  }, [cards.data?.items, selectedId]);

  const refresh = () => { setNotice(null); void cards.refetch(); if (selectedId) void detail.refetch(); void queryClient.invalidateQueries({ queryKey: ["agent-grants", workspaceSlug] }); };

  const requestRevoke = (grant: AgentGrantSummary) => setConfirm({
    title: `Revoke access for ${grant.agentId}?`,
    detail: `This stops the recorded ${grant.capability} grant for ${grant.resourceKind}:${grant.resourceRef}. The provider account remains connected; a future grant still requires the Portal handoff.`,
    label: "Revoke grant",
    danger: true,
    run: () => revokeAgentGrant(grant.id),
  });

  if (operatorSession.isLoading) return <main className="boot-state"><BrandMark /><LoaderCircle className="spin" /><span>Checking Marketplace authority…</span></main>;
  if (operatorSession.error) return <main className="boot-state"><StatePanel error={operatorSession.error} onRetry={() => void operatorSession.refetch()} /></main>;
  if (!authenticated) return <UnlockScreen session={operatorSession.data?.session ?? { configured: false, authenticated: false, mode: "unconfigured", principal: null, csrfToken: null, expiresAt: null }} onUnlocked={() => void queryClient.invalidateQueries({ queryKey: ["marketplace-session"] })} />;
  if (bootstrap.isLoading) return <main className="boot-state"><BrandMark /><LoaderCircle className="spin" /><span>Opening Marketplace…</span></main>;
  if (bootstrap.error) return <main className="boot-state"><StatePanel error={bootstrap.error} onRetry={() => void bootstrap.refetch()} /></main>;

  return <main className="app-shell">
    <MarketplaceNav section={section} onSection={setSection} providers={cards.data?.providers} onSettings={() => setSettingsOpen(true)} />
    <section className="application-frame">
      <header className="topbar"><div className="verified-scope"><span className="eyebrow">Verified organization</span><code>{workspaceSlug}</code></div><div><span className="program-state"><span />Program online</span><Button size="small" onClick={refresh}><RefreshCw size={14} />Refresh</Button><IconButton className="topbar-settings" aria-label="Open settings" onClick={() => setSettingsOpen(true)}><Settings size={16} /></IconButton></div></header>
      {section === "grants" ? <AgentGrantsPage workspaceSlug={workspaceSlug} onRevoke={requestRevoke} /> : cards.error ? <StatePanel error={cards.error} onRetry={() => void cards.refetch()} /> : section === "connections" && cards.data ? <ConnectionsPage connections={cards.data.connections} providers={cards.data.providers} /> : section === "activity" ? <ActivityPage workspaceSlug={workspaceSlug} /> : <div className="catalog-layout">
        <aside className="catalog-index"><div className="index-heading"><div><p className="eyebrow">{installed ? "Workspace inventory" : "Capability catalog"}</p><h2>{installed ? "Installed" : "Discover"}</h2></div><Tag>{cards.data?.filteredTotal ?? 0}</Tag></div><label className="search-box"><Search size={15} /><input aria-label="Search catalog" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search providers and tools…" /></label><label className="source-filter"><Filter size={14} /><select aria-label="Filter by source" value={source} onChange={(event) => setSource(event.target.value)}><option value="all">All sources</option>{cards.data?.sources.map((entry) => <option key={entry} value={entry}>{words(entry)}</option>)}</select></label><div className="catalog-list">{cards.isLoading ? <div className="list-loading"><LoaderCircle className="spin" />Loading live catalog…<small>Summary pages remain bounded to {PAGE_SIZE} records.</small></div> : cards.data?.items.length ? cards.data.items.map((card) => <CatalogRow key={card.pluginId} card={card} selected={selectedId === card.pluginId} onSelect={() => setSelectedId(card.pluginId)} />) : <div className="list-empty">No matching capabilities.</div>}</div>{cards.data && cards.data.filteredTotal > PAGE_SIZE && <footer className="index-footer"><Button size="small" disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}>Previous</Button><span>{offset + 1}–{Math.min(offset + PAGE_SIZE, cards.data.filteredTotal)} of {cards.data.filteredTotal}</span><Button size="small" disabled={!cards.data.hasMore} onClick={() => setOffset((value) => value + PAGE_SIZE)}>Next</Button></footer>}</aside>
        <section className="primary-workspace">{detail.error ? <StatePanel error={detail.error} onRetry={() => void detail.refetch()} /> : <PluginWorkspace card={detail.data?.card ?? null} loading={detail.isLoading && Boolean(selectedId)} workspaceSlug={workspaceSlug} onConfirm={setConfirm} onRefresh={refresh} />}</section>
      </div>}
      {notice && <div className="toast" role="status"><CheckCircle2 size={16} />{notice}<button aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={14} /></button></div>}
    </section>
    <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} onSuccess={() => { setNotice("Marketplace recorded the governed lifecycle change."); refresh(); }} />
    <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} bootstrap={bootstrap.data!} workspaceSlug={workspaceSlug} session={operatorSession.data!.session} onLogout={() => void queryClient.invalidateQueries({ queryKey: ["marketplace-session"] })} />
  </main>;
}
