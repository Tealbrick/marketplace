import { useEffect, useRef } from "react";
import { Filter, LoaderCircle, Search, X } from "lucide-react";
import { Button } from "@tealbrick/ui";

import { CatalogRow } from "./Catalog";
import { CONNECT_MODE_LABELS, CONNECT_MODE_ORDER } from "./copy";
import type { CardsSummaryResponse } from "./types";
import { words } from "./ui";

const count = (value: number) => value.toLocaleString("en-US");

/** Per-status counts with a toggle filter; the Program derives each card's status. */
function ConnectModeFilter({ counts, value, onChange }: { counts: Partial<Record<string, number>> | undefined; value: string; onChange: (mode: string) => void }) {
  if (!counts) return null;
  const visible = CONNECT_MODE_ORDER.filter((mode) => (counts[mode] ?? 0) > 0 || mode === value);
  if (!visible.length) return null;
  return (
    <div className="connect-mode-filter" role="group" aria-label="Filter by connection status">
      <button type="button" aria-pressed={value === "all"} onClick={() => onChange("all")}>All</button>
      {visible.map((mode) => <button key={mode} type="button" aria-pressed={value === mode} onClick={() => onChange(value === mode ? "all" : mode)}>{CONNECT_MODE_LABELS[mode]}<span>{counts[mode] ?? 0}</span></button>)}
    </div>
  );
}

export interface CatalogFilters {
  search: string;
  source: string;
  connectMode: string;
}

export const NO_FILTERS: CatalogFilters = { search: "", source: "all", connectMode: "all" };

export function filtersActive(filters: CatalogFilters) {
  return filters.search.trim() !== "" || filters.source !== "all" || filters.connectMode !== "all";
}

/**
 * The catalog column: the full count up front, filters with one "Clear filters", and a list that
 * loads the next page when its end scrolls into view (with a button as the fallback).
 */
export function CatalogIndex({ installed, data, loading, loadingMore, filters, onFilters, selectedId, onSelect, onLoadMore }: {
  installed: boolean;
  data: CardsSummaryResponse | undefined;
  loading: boolean;
  loadingMore: boolean;
  filters: CatalogFilters;
  onFilters: (next: CatalogFilters) => void;
  selectedId: string | null;
  onSelect: (pluginId: string) => void;
  onLoadMore: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const hasMore = data?.hasMore === true;

  useEffect(() => {
    const root = listRef.current;
    const end = endRef.current;
    if (!root || !end || !hasMore || loadingMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) onLoadMore(); }, { root, rootMargin: "240px 0px" });
    observer.observe(end);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, onLoadMore, data?.items.length]);

  const total = data ? (installed ? data.installedTotal : data.total) : 0;
  const filtered = filtersActive(filters);
  const shown = data?.items.length ?? 0;
  const noun = installed ? "installed" : "connectors";

  return (
    <aside className="catalog-index">
      <div className="index-heading">
        <div>
          <p className="eyebrow">{installed ? "Your workspace" : "Catalog"}</p>
          <h2>{installed ? "Installed" : "Discover"}</h2>
          <p className="index-count" aria-live="polite">
            {data ? <><strong>{count(total)}</strong> {noun}{filtered && <> · <strong>{count(data.filteredTotal)}</strong> match</>}</> : "Counting…"}
          </p>
        </div>
        {filtered && <Button size="small" onClick={() => onFilters(NO_FILTERS)}><X size={13} />Clear filters</Button>}
      </div>
      <label className="search-box"><Search size={15} /><input aria-label="Search catalog" value={filters.search} onChange={(event) => onFilters({ ...filters, search: event.target.value })} placeholder="Search providers and tools…" /></label>
      <label className="source-filter"><Filter size={14} /><select aria-label="Filter by source" value={filters.source} onChange={(event) => onFilters({ ...filters, source: event.target.value })}><option value="all">All sources</option>{data?.sources.map((entry) => <option key={entry} value={entry}>{words(entry)}</option>)}</select></label>
      <ConnectModeFilter counts={data?.connectModeCounts} value={filters.connectMode} onChange={(connectMode) => onFilters({ ...filters, connectMode })} />
      <div className="catalog-list" ref={listRef}>
        {loading ? <div className="list-loading"><LoaderCircle className="spin" />Loading catalog…</div>
          : shown ? <>
            {data!.items.map((card) => <CatalogRow key={card.pluginId} card={card} selected={selectedId === card.pluginId} onSelect={() => onSelect(card.pluginId)} />)}
            <div ref={endRef} className="list-end" aria-hidden={!hasMore}>{hasMore && loadingMore && <LoaderCircle className="spin" size={14} />}</div>
          </>
          : <div className="list-empty">No matching capabilities.</div>}
      </div>
      {data && shown > 0 && <footer className="index-footer">
        <span>Showing {count(shown)} of {count(data.filteredTotal)}</span>
        {hasMore && <Button size="small" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? "Loading…" : "Load more"}</Button>}
      </footer>}
    </aside>
  );
}
