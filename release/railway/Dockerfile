FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ENV NODE_ENV=production MARKETPLACE_HOST=0.0.0.0 MARKETPLACE_PORT=5314 MARKETPLACE_DATA_DIR=/data/state
WORKDIR /app
RUN mkdir -p /data/state /data/logs && chown node:node /data/state /data/logs && chmod 0700 /data/state /data/logs
COPY --chown=node:node entrypoint.mjs ./entrypoint.mjs
COPY --chown=node:node dist ./dist
COPY --chown=node:node web-dist ./web-dist
USER node
EXPOSE 5314
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:5314/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "entrypoint.mjs"]
