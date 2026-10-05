import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const iconsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/icons");

const ICONS = [
  { file: "favicon-32.png", sizes: "32x32", rel: "icon" },
  { file: "favicon-48.png", sizes: "48x48", rel: "icon" },
  { file: "apple-touch-icon.png", sizes: "180x180", rel: "apple-touch-icon" },
  { file: "icon-192.png", sizes: "192x192" },
  { file: "icon-512.png", sizes: "512x512" },
  { file: "icon-maskable-512.png", sizes: "512x512", purpose: "maskable" },
];

const version = (source) => createHash("sha256").update(source).digest("hex").slice(0, 10);

/**
 * Emits the Teal Brick favicon, touch icon and web manifest for a Micro-app.
 * Every icon is rendered from the official teal-brick-colour.png artwork.
 *
 * Files land in Vite's `build.assetsDir` (default `assets/`), which Micro-app
 * Programs already serve publicly with long-lived caching, so URLs carry a
 * content version query instead of relying on new server routes.
 */
export function tealbrickAppIcons({ name, shortName = name, themeColor = "#173f3c", darkThemeColor = "#0f1f1d", backgroundColor = "#f3f1e9" }) {
  const icons = ICONS.map((icon) => {
    const source = readFileSync(path.join(iconsDir, icon.file));
    return { ...icon, source, query: `?v=${version(source)}` };
  });
  let base = "/";
  let assetsDir = "assets";
  const manifest = () => JSON.stringify({
    name,
    short_name: shortName,
    // The manifest lives in assetsDir; start_url and scope resolve against it.
    start_url: base.startsWith("/") ? base : "../",
    scope: base.startsWith("/") ? base : "../",
    display: "standalone",
    background_color: backgroundColor,
    theme_color: themeColor,
    icons: icons.filter((icon) => !icon.rel).map((icon) => ({
      src: `icons/${icon.file}${icon.query}`,
      sizes: icon.sizes,
      type: "image/png",
      ...(icon.purpose ? { purpose: icon.purpose } : {}),
    })),
  }, null, 2);
  return {
    name: "tealbrick-app-icons",
    configResolved(config) {
      base = config.base.endsWith("/") ? config.base : `${config.base}/`;
      assetsDir = config.build.assetsDir.replace(/^\/+|\/+$/gu, "");
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? "").split("?")[0];
        const prefix = `${base}${assetsDir}/`;
        if (!pathname.startsWith(prefix)) return next();
        const file = pathname.slice(prefix.length);
        if (file === "manifest.webmanifest") {
          response.setHeader("content-type", "application/manifest+json");
          response.end(manifest());
          return;
        }
        const icon = icons.find((entry) => file === `icons/${entry.file}`);
        if (!icon) return next();
        response.setHeader("content-type", "image/png");
        response.end(icon.source);
      });
    },
    generateBundle() {
      for (const icon of icons) {
        this.emitFile({ type: "asset", fileName: `${assetsDir}/icons/${icon.file}`, source: icon.source });
      }
      this.emitFile({ type: "asset", fileName: `${assetsDir}/manifest.webmanifest`, source: manifest() });
    },
    transformIndexHtml() {
      const href = (file) => `${base}${assetsDir}/${file}`;
      return [
        ...icons.filter((icon) => icon.rel).map((icon) => ({
          tag: "link",
          attrs: { rel: icon.rel, ...(icon.rel === "icon" ? { type: "image/png" } : {}), sizes: icon.sizes, href: href(`icons/${icon.file}${icon.query}`) },
          injectTo: "head",
        })),
        { tag: "link", attrs: { rel: "manifest", href: href(`manifest.webmanifest?v=${version(manifest())}`) }, injectTo: "head" },
        { tag: "meta", attrs: { name: "theme-color", content: themeColor, media: "(prefers-color-scheme: light)" }, injectTo: "head" },
        { tag: "meta", attrs: { name: "theme-color", content: darkThemeColor, media: "(prefers-color-scheme: dark)" }, injectTo: "head" },
      ];
    },
  };
}
