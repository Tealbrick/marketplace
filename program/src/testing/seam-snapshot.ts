// Normalises responses, usage-ledger rows and audit rows for the executor
// seam snapshots: ids, timestamps, trace ids and generated plugin suffixes
// vary per run; everything else must stay byte-identical across refactors.
export function seamSnapshot(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "<uuid>")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu, "<time>")
      .replace(/mcp-cb-tracker-[0-9a-f]{8}/gu, "mcp-cb-tracker-<id>")
      .replace(/trace-[a-z0-9]+-[a-z0-9]+/gu, "<trace>"),
  );
}

/** Runtime execution audit rows for one plugin, sorted by type, without row ids or times. */
export function runtimeAuditRows(rows: unknown[], pluginId: string) {
  return (rows as Array<Record<string, unknown>>)
    .filter((row) => row.plugin_id === pluginId && String(row.event_type).startsWith("marketplace.runtime."))
    .map(({ id: _id, created_at: _createdAt, ...row }) => row)
    .sort((a, b) => String(a.event_type).localeCompare(String(b.event_type)));
}
