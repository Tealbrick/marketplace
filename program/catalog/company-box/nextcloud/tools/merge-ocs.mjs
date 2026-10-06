#!/usr/bin/env node
// Merge per-app Nextcloud OpenAPI documents (upstream OCS plus hand-authored) into one namespaced OpenAPI 3.0.3 document.
// Usage: node merge-ocs.mjs <out.json> <name>=<file> ...   (deterministic: sorted by app name; called by build.sh)
import { readFileSync, writeFileSync } from "node:fs";

const [out, ...pairs] = process.argv.slice(2);
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace", "x-propfind", "x-proppatch", "x-mkcol", "x-move", "x-copy", "x-report", "x-lock", "x-unlock"];
const sources = pairs.map((p) => {
  const i = p.indexOf("=");
  return { app: p.slice(0, i), doc: JSON.parse(readFileSync(p.slice(i + 1), "utf8")) };
}).sort((a, b) => (a.app < b.app ? -1 : 1));

const rewrite = (node, app) => {
  if (Array.isArray(node)) return node.map((n) => rewrite(n, app));
  if (!node || typeof node !== "object") return node;
  const result = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$ref" && typeof v === "string" && v.startsWith("#/components/schemas/")) {
      result[k] = `#/components/schemas/${app}.${v.slice("#/components/schemas/".length)}`;
    } else if (k === "discriminator" && v && v.mapping) {
      result[k] = { ...v, mapping: Object.fromEntries(Object.entries(v.mapping).map(([a, b]) => [a, String(b).replace(/^#\/components\/schemas\//u, `#/components/schemas/${app}.`)])) };
    } else {
      result[k] = rewrite(v, app);
    }
  }
  return result;
};

const merged = {
  openapi: "3.0.3",
  info: {
    title: "Nextcloud 31.0.14 API (merged per-app OpenAPI plus hand-authored WebDAV, activity, serverinfo)",
    version: "31.0.14",
    description: "Per-app OpenAPI documents published by Nextcloud and its apps, merged without changing any operation, plus hand-authored documents (marked x-source: hand-authored) for WebDAV, activity and serverinfo. Component schemas are namespaced `<app>.<Name>`; every operation carries `x-nextcloud-app`.",
    "x-source": "merged-upstream",
  },
  tags: [],
  paths: {},
  components: { securitySchemes: {}, schemas: {} },
};
const opIds = new Map();
const report = { collisions: [], perApp: {}, notes: [] };
for (const { app, doc } of sources) {
  let n = 0;
  for (const [name, scheme] of Object.entries(doc.components?.securitySchemes ?? {})) {
    const prev = merged.components.securitySchemes[name];
    if (prev && JSON.stringify(prev) !== JSON.stringify(scheme)) report.notes.push(`securityScheme ${name} differs in ${app}`);
    merged.components.securitySchemes[name] = scheme;
  }
  for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
    merged.components.schemas[`${app}.${name}`] = rewrite(schema, app);
  }
  for (const t of doc.tags ?? []) merged.tags.push({ ...t, name: `${app}/${t.name}` });
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const target = (merged.paths[path] ??= {});
    for (const [key, value] of Object.entries(item)) {
      if (!METHODS.includes(key)) {
        if (key === "parameters") { target.parameters = [...(target.parameters ?? []), ...rewrite(value, app)]; continue; }
        report.notes.push(`${app} ${path}: path-level key ${key} ignored`);
        continue;
      }
      if (target[key]) { report.collisions.push(`${key.toUpperCase()} ${path} (${app})`); continue; }
      const op = rewrite(value, app);
      if (op.operationId) {
        const prev = opIds.get(op.operationId);
        if (prev) { report.collisions.push(`operationId ${op.operationId} (${prev} vs ${app})`); op.operationId = `${app}-${op.operationId}`; }
        opIds.set(op.operationId, app);
      }
      op.tags = [app, ...(op.tags ?? []).map((t) => `${app}/${t}`)];
      if (doc.info?.["x-source"] === "hand-authored") op["x-source"] = "hand-authored";
      op["x-nextcloud-app"] = app;
      target[key] = op;
      n += 1;
    }
  }
  report.perApp[app] = n;
  if (doc.info?.["x-source"] === "hand-authored") (merged.info["x-hand-authored-apps"] ??= []).push(app);
}
// Deterministic ordering
merged.paths = Object.fromEntries(Object.entries(merged.paths).sort(([a], [b]) => (a < b ? -1 : 1)));
merged.components.schemas = Object.fromEntries(Object.entries(merged.components.schemas).sort(([a], [b]) => (a < b ? -1 : 1)));
writeFileSync(out, `${JSON.stringify(merged, null, 2)}\n`);
console.log(JSON.stringify({ total: Object.values(report.perApp).reduce((a, b) => a + b, 0), ...report }, null, 1));
