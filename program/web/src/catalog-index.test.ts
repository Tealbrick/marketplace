// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CatalogIndex, type CatalogFilters, filtersActive, NO_FILTERS } from "./CatalogIndex";
import type { CardsSummaryResponse } from "./types";

afterEach(cleanup);

const summary = (overrides: Partial<CardsSummaryResponse> = {}): CardsSummaryResponse => ({
  workspaceSlug: "w",
  providers: {} as CardsSummaryResponse["providers"],
  total: 1624,
  filteredTotal: 1624,
  installedTotal: 4,
  offset: 0,
  limit: 60,
  hasMore: true,
  sources: ["composio"],
  connectModeCounts: { ready_managed: 119, ready_user_key: 1281 },
  connections: [],
  items: [],
  ...overrides,
});

const view = (input: { data?: CardsSummaryResponse; filters?: CatalogFilters; installed?: boolean; onFilters?: (next: CatalogFilters) => void; onLoadMore?: () => void }) =>
  render(createElement(CatalogIndex, {
    installed: input.installed ?? false,
    data: input.data,
    loading: false,
    loadingMore: false,
    filters: input.filters ?? NO_FILTERS,
    onFilters: input.onFilters ?? (() => {}),
    selectedId: null,
    onSelect: () => {},
    onLoadMore: input.onLoadMore ?? (() => {}),
  }));

describe("CatalogIndex", () => {
  it("shows the full catalog count, not the page size", () => {
    const { container } = view({ data: summary() });
    expect(container.querySelector(".index-count")?.textContent).toBe("1,624 connectors");
    expect(screen.queryByRole("button", { name: /Clear filters/ })).toBeNull();
  });

  it("shows the match count and one Clear filters that resets search, source and status", () => {
    const onFilters = vi.fn();
    const { container } = view({ data: summary({ filteredTotal: 119 }), filters: { search: "", source: "composio", connectMode: "ready_managed" }, onFilters });
    expect(container.querySelector(".index-count")?.textContent).toBe("1,624 connectors · 119 match");
    fireEvent.click(screen.getByRole("button", { name: /Clear filters/ }));
    expect(onFilters).toHaveBeenCalledWith(NO_FILTERS);
  });

  it("offers Load more while pages remain and reports how many are shown", () => {
    const onLoadMore = vi.fn();
    const item = { pluginId: "composio-slack", displayName: "Slack", description: "Team chat", sourceLabel: "Slack via Composio", source: "composio", status: "available", connectMode: "ready_managed" } as CardsSummaryResponse["items"][number];
    view({ data: summary({ items: [item] }), onLoadMore });
    expect(screen.getByText("Showing 1 of 1,624")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("counts installed connectors in the Installed view", () => {
    const { container } = view({ data: summary({ hasMore: false }), installed: true });
    expect(container.querySelector(".index-count")?.textContent).toBe("4 installed");
  });
});

describe("filtersActive", () => {
  it("is false only for no search, all sources and all statuses", () => {
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, search: "  " })).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, search: "slack" })).toBe(true);
    expect(filtersActive({ ...NO_FILTERS, source: "composio" })).toBe(true);
    expect(filtersActive({ ...NO_FILTERS, connectMode: "no_auth" })).toBe(true);
  });
});
