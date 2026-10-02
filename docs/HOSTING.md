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

## Confirmed on Render (2026-10-01)

I created the service on 2026-10-01 and probed it from outside with no secret. These facts are now confirmed.

- **URL.** The name was free, so the service answers at `https://titan-gev.onrender.com`. Render's API reports the same URL.
- **Build memory.** Render's free-plan builder ran the Docker build, including the Vite build that peaks near 1.4 GB, with no
  out of memory error. The first deploy went live 68 seconds after it started.
- **No payment step.** Creating the free service through Render's API on this account asked for no card.
- **Headers pass through.** Render's edge is Cloudflare. It left the gateway's response headers alone. `/healthz`
  returned 200 with the dashboard origin in `access-control-allow-origin`. Every gateway response carried
  `frame-ancestors https://shreyas-tech7.github.io` and none carried `X-Frame-Options`. A foreign origin got no CORS header.
- **The gate holds.** With no token, `/`, `/assets/*`, `/api/setup/status` and `/api/realtime/token` all returned 401.
  A garbage token returned 401. `PUT` returned 405.
- **The rate limit keys on the real client.** Failed attempts started returning 429 after the budget ran out, and a random
  `X-Forwarded-For` on each request did not avoid it. A request with a forged `cf-connecting-ip` never reached the
  gateway. Cloudflare rejected it with error 1000.
- **Wake time.** The service answered `/healthz` within 30 seconds of the deploy going live.

## Confirmed by the live check (2026-10-02)

The GEV live check workflow in TITAN-Runner mints a fresh access token, runs `npm run verify:live`, and drives a headless
browser through the dashboard. Its latest runs passed every check.

- **The cookie survives.** Render's edge leaves `Set-Cookie` with `Partitioned` untouched. The cookie kept `Secure`,
  `HttpOnly`, `SameSite=None`, and `Partitioned`.
- **No leaks.** No response body contains the token or the cookie.
- **The globe loads.** In the dashboard iframe the status bar reads Reachable, the frame loads, no blocked cookie banner
  shows, and the frame holds a canvas.

## Still unconfirmed

- A live check that starts against a sleeping host. Both passing browser runs found the host awake. The workflow waits up to
  120 seconds for a cold host, but no run has shown that wait end in Reachable.

## Settings the Blueprint would have set

I created this service through Render's API, not the Blueprint. The API call cannot set two settings that
`render.yaml` sets, so I changed them in the Render dashboard afterward. Render's API now reports both.

- **Health Check Path** is `/healthz`. Render now waits for the gateway to report ready before it moves traffic to a new deploy.
- **Auto-Deploy** is **After CI checks pass**, so a commit that fails the build workflow does not deploy.

If you recreate the service by hand, set both again. Creating it from `render.yaml` sets them for you.
