import { after, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("../", import.meta.url)),
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
  esbuild: { jsx: "automatic" },
});
after(() => server.close());
const { TextareaField, SectionNavigation } = await server.ssrLoadModule("/src/primitives.tsx");
const render = props => renderToStaticMarkup(createElement(TextareaField, props));

test("section navigation uses labeled non-submitting buttons and one current page", () => {
  const html = renderToStaticMarkup(createElement(SectionNavigation, { current: "one", onSelect() {}, items: [{ id: "one", label: "First" }, { id: "two", label: "Second", disabled: true }] }));
  assert.match(html, /aria-label="Settings sections"/);
  assert.equal((html.match(/type="button"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /role="tab/);
});

test("textarea associates its label, caller help, description and error", () => {
  const html = render({ label: "Rationale", id: "reason", description: "Context", error: "Required", "aria-describedby": "external", required: true });
  assert.match(html, /for="reason"/);
  assert.match(html, /aria-describedby="external reason-description reason-error"/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /id="reason-description"/);
  assert.match(html, /id="reason-error"/);
  assert.match(html, /rows="4"/);
});
test("textarea preserves native readonly rows and escaped content", () => {
  const html = render({ label: "Notes", defaultValue: "<script>sample</script>\nnext", readOnly: true, rows: 7, maxLength: 250 });
  assert.match(html, /readOnly=""/i);
  assert.match(html, /rows="7"/);
  assert.match(html, /maxLength="250"/i);
  assert.match(html, /&lt;script&gt;sample&lt;\/script&gt;\nnext/);
  assert.doesNotMatch(html, /aria-invalid|aria-describedby/);
});
test("textarea preserves disabled and dialog autofocus semantics", () => {
  const html = render({ label: "Notes", disabled: true, autoFocus: true, className: "consumer-layout" });
  assert.match(html, /disabled=""/);
  assert.match(html, /data-dg-autofocus="true"/);
  assert.match(html, /class="dg-input dg-textarea consumer-layout"/);
});
