# Source template for release/railway/Dockerfile. The release cut copies this
# file, entrypoint.mjs and tailnet.mjs into release/railway; never edit the
# generated copy.

# Tailscale static binaries for optional tailnet reachability (inert unless
# TS_AUTHKEY is set at runtime). Pinned version and sha256: the build fails on
# any mismatch.
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS tailscale
WORKDIR /tailscale
RUN node -e ' \
  const crypto = require("node:crypto"); \
  const fs = require("node:fs"); \
  const version = "1.102.5"; \
  const expected = "65e6d7f19ad7e1c87d20c2a21e92f38a96795cb897af54b04536590e1c148d12"; \
  const url = `https://pkgs.tailscale.com/stable/tailscale_${version}_amd64.tgz`; \
  fetch(url, { redirect: "follow" }).then(async (response) => { \
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`); \
    const bytes = Buffer.from(await response.arrayBuffer()); \
    const actual = crypto.createHash("sha256").update(bytes).digest("hex"); \
    if (actual !== expected) throw new Error(`tailscale sha256 mismatch: expected ${expected}, got ${actual}`); \
    fs.writeFileSync("tailscale.tgz", bytes); \
  }).catch((error) => { console.error(error.message); process.exit(1); });' \
  && tar -xzf tailscale.tgz --strip-components=1 tailscale_1.102.5_amd64/tailscale tailscale_1.102.5_amd64/tailscaled \
  && rm tailscale.tgz \
  && chmod 0755 tailscale tailscaled

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ENV NODE_ENV=production MARKETPLACE_HOST=0.0.0.0 MARKETPLACE_PORT=5314 MARKETPLACE_DATA_DIR=/data/state
WORKDIR /app
RUN mkdir -p /data/state /data/logs && chown node:node /data/state /data/logs && chmod 0700 /data/state /data/logs
COPY --from=tailscale /tailscale/tailscale /tailscale/tailscaled /usr/local/bin/
COPY --chown=node:node entrypoint.mjs ./entrypoint.mjs
COPY --chown=node:node tailnet.mjs ./tailnet.mjs
COPY --chown=node:node dist ./dist
COPY --chown=node:node web-dist ./web-dist
USER node
EXPOSE 5314
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:5314/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "entrypoint.mjs"]
