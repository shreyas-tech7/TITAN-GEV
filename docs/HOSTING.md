# Where to host TITAN-GEV for free

The globe needs a Node server, because its live data proxies run as server middleware. A static host cannot
serve it. The gateway in this repo also needs to set response headers and a cookie. So the host must run a
container or a Node process. The rule for this project is $0 and no credit card.

This page records the research and the choice. Details change, so each row links to its source. The research
ran on 2026-10-01.

## What blocked the first plan

Hugging Face Spaces was the first choice. As of this date, the
[Spaces overview](https://huggingface.co/docs/hub/spaces-overview) says: "Static Spaces are free for everyone.
Gradio and Docker Spaces run on compute and require a paid plan to create: PRO for personal accounts, Team or
Enterprise for organizations." The CPU Basic hardware costs nothing per hour, but creating a Docker Space needs
PRO. A free account cannot create this Space.

## Options compared

| Host | Card needed | Memory and CPU | Sleep behavior | Verdict |
| --- | --- | --- | --- | --- |
| [Render](https://render.com/docs/free) free web service | No, per Render's own [article](https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026). Some reviews report a card check, so treat it as unconfirmed | 512 MB, 0.1 CPU | Spins down after 15 minutes without traffic and wakes in about a minute. 750 free hours a month | **Chosen** |
| Hugging Face Docker Space | No card, but PRO is required | 16 GB, 2 vCPU | Sleeps when idle | Blocked |
| [SnapDeploy](https://snapdeploy.dev/blog/free-cloud-deployment-platforms-2026-comparison) | No | 512 MB, 0.25 vCPU | Sleeps after 15 minutes. Only 100 running hours a month | Backup. Small vendor and fewer hours |
| Railway free plan | No | 1 vCPU, 0.5 GB | No sleep unless Serverless is on | $1 of credit a month runs out in days |
| Back4app Containers | No | 256 MB | A free container runs 60 minutes per deploy | Too small and too short |
| Koyeb | Yes | 512 MB | Scales to zero after 1 hour | New users lost the free tier in February 2026 |
| Fly.io, Google Cloud Run, Oracle Cloud | Yes | Varies | Varies | Need a card |
| Vercel, Netlify, Cloudflare Workers | No | Serverless | None | Cannot run the app's long-lived server |
| GitHub Codespaces | No | 2 cores | Stops when idle, and nothing wakes it from a web request | Fallback only. See the README |

Hugging Face also offers free Gradio Spaces on ZeroGPU for machine learning demos. Running a Node server there
would misuse a quota meant for models, and it would need a Python wrapper. This project does not do that.

## Why Render

1. It is the only no-card option with enough memory and hours for one always-reachable service.
2. The image runs inside the 512 MB limit. A test on 2026-10-01 ran the real image under `--memory 512m` and
   `--cpus 0.1` with 19 live data layers on in a real browser. The container became ready in 12 seconds, idled at
   133 MiB, peaked at 205 MiB, and was never killed.
3. The gateway controls every response header and the cookie, so Render's proxy does not change the security model.
4. The dashboard tab already handles a sleeping host. It shows "Waking up, this can take a minute" and retries.
5. A Blueprint (`render.yaml`) turns setup into one form where you paste two values.

## Behavior on Render that the code handles

- **Port.** Render gives the service a `PORT` (default 10000). The gateway uses `GEV_LISTEN_PORT`, then `PORT`, then 7860.
- **Client address.** Render puts Cloudflare in front, and the first `X-Forwarded-For` entries are client controlled.
  The blueprint sets `GEV_CLIENT_IP_HEADER=cf-connecting-ip`. When that header is set, the gateway never reads
  `X-Forwarded-For`.
- **Memory.** The app process runs with a 256 MB V8 heap cap and Vite's native config loader. The native loader
  alone cut the app from 361 MiB to 113 MiB at idle.
- **Sleep.** Render serves its own loading page while a service wakes. That page has no CORS headers, so the dashboard
  sees the host as "down" and keeps retrying until the gateway answers. The dashboard also pings `/healthz` every
  30 seconds while the tab is open, which keeps the service awake.
- **Framing.** The gateway sends `frame-ancestors` for the dashboard origin only. Run `npm run verify:live` after the
  first deploy to confirm that Render adds no `X-Frame-Options` header of its own.

## Unconfirmed

- Whether Render asks for a card at sign-up for this account.
- Whether Render's proxy leaves `Set-Cookie` with `Partitioned` untouched. The live verifier checks it.
- Whether Render's free build environment has enough memory. The Vite build peaks near 1.4 GB. If the Render
  build log shows an out-of-memory error, that is the cause.
- The exact URL. Render uses `https://titan-gev.onrender.com` when the name is free and adds a suffix when it is not.
  Read the real URL from the Render dashboard.
