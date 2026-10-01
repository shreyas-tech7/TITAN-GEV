#!/usr/bin/env bash
# Prepare a Codespace. Fetch the pinned upstream commit and install its dependencies.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

bash scripts/fetch-upstream.sh .upstream
cd .upstream
PUPPETEER_SKIP_DOWNLOAD=1 npm ci --no-audit --no-fund
npm run doctor

cat <<'MSG'

Ready. Start one of these when you want the globe:
  npm run dev:codespace    dev server on 0.0.0.0:4173 (port 4173 stays private unless you change it)
  npm run upstream:build && npm start    the gated wrapper on 0.0.0.0:7860

Stop the server when you finish. Codespaces sleeps on its own after idle time.
MSG
