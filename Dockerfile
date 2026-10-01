# TITAN-GEV image. Builds the pinned God's Eye View commit, then runs it behind the gate.
# Hugging Face Spaces (Docker SDK) builds this file as is.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Fetch the exact commit named in UPSTREAM_COMMIT. No upstream code lives in this repo.
COPY UPSTREAM_COMMIT ./UPSTREAM_COMMIT
COPY scripts/fetch-upstream.sh ./scripts/fetch-upstream.sh
RUN bash scripts/fetch-upstream.sh /app/upstream

WORKDIR /app/upstream
# The Cesium ion token is a placeholder here. The wrapper swaps in the real value
# at container start from the host's secret store, so no secret enters an image layer.
RUN PUPPETEER_SKIP_DOWNLOAD=1 npm ci --no-audit --no-fund \
 && NODE_OPTIONS=--max-old-space-size=3072 CESIUM_ION_TOKEN=__GEV_CESIUM_ION_TOKEN__ npx vite build \
 && rm -rf .git

COPY server /app/server
RUN chown -R node:node /app

USER node
ENV GEV_APP_DIR=/app/upstream \
    GEV_LISTEN_PORT=7860

EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s \
  CMD node -e "fetch('http://127.0.0.1:7860/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/server/index.mjs"]
