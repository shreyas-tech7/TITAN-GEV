---
title: TITAN GEV
emoji: 🌍
colorFrom: gray
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
short_description: Gated God's Eye View globe for the TITAN dashboard
---

# TITAN-GEV

TITAN-GEV hosts the open source [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) globe
at a public URL and gates it, so the TITAN dashboard can embed it as a tab. The globe shows live
flights, military flights, earthquakes, satellites, street traffic, and CCTV in a full 3D Earth with
the app's own HUD.

This repository holds no upstream code. It holds a Dockerfile, a small gateway server, tests, and CI.
The Docker build fetches one pinned upstream commit and builds it unchanged.

> **Attribution.** God's Eye View is by Bilawal Sidhu and uses the MIT license.
> See [NOTICE.md](NOTICE.md) for the license text and the third party data terms.
> This deployment is for personal, non-commercial use.

## How it fits together

```
TITAN dashboard (GitHub Pages)              Free host (Render, this repo's image)
  |                                           |
  |  1. GET /gev/token  (admin token)         |
  |------------------> TITAN Worker           |
  |  2. signed token, valid 5 minutes         |
  |<------------------                        |
  |                                           |
  |  3. iframe src = host URL + ?gev_token=   |
  |------------------------------------------>  gateway (PORT)
  |                                              | verifies the token, sets a session cookie
  |                                              v
  |                                            God's Eye View preview server (127.0.0.1:4173)
```

The app needs a Node server. Its live data proxies run as Vite middleware, so a static host
cannot serve it. The gateway is the only listener the internet can reach. The app listens on
loopback only.

## Where it runs

**Render's free web service.** Hugging Face now requires a paid PRO plan to create a Docker Space, so it
cannot serve this app for $0. [docs/HOSTING.md](docs/HOSTING.md) compares the free options with sources
and explains the choice.

The image fits Render's 512 MB limit. A test under `--memory 512m` and `--cpus 0.1` with 19 live layers on
peaked at 205 MiB and was never killed.

## Security model

The host URL is public, so the gateway never acts as an open proxy.

- **Access token.** The TITAN Worker mints `gev1.<iat>.<exp>.<id>.<signature>`. The signature is
  HMAC-SHA256 over the first four parts with `GEV_SHARED_SECRET`. A token lives 5 minutes. The
  gateway rejects any token that claims a lifetime over 10 minutes and accepts each token once.
- **Session cookie.** A valid token becomes the cookie `__Host-gev_session` with `Secure`,
  `HttpOnly`, `SameSite=None`, and `Partitioned`. The partition lets the cookie work inside the
  dashboard iframe even when the browser blocks ordinary third party cookies. The session expires
  after 30 idle minutes, slides while in use, and ends after 6 hours at most.
- **Redirect to a clean URL.** After the cookie is set, the page replaces the URL, so the token never
  stays in history or a Referer header.
- **Plain 401.** A missing, expired, reused, or forged token returns a bare 401 page. The page never
  says which check failed.
- **Fails closed.** If `GEV_SHARED_SECRET` is missing or shorter than 32 characters, every gated route
  returns 401.
- **Rate limits.** API routes allow 1200 requests per minute for each session. Failed attempts without a
  valid session allow 30 per minute for each client address. A valid redemption never spends that budget.
  Limits live in memory and reset on restart.
- **Client address.** Behind Render's Cloudflare layer the first `X-Forwarded-For` entries are client
  controlled. Set `GEV_CLIENT_IP_HEADER=cf-connecting-ip` and the gateway reads that header and never
  reads `X-Forwarded-For`.
- **Framing.** The app sends `X-Frame-Options: DENY` to protect its Provider Settings page. The
  gateway replaces that with `frame-ancestors` set to the dashboard origin and nothing else.
- **Provider Settings stays off.** The preview server does not register the key saving routes at all.
  The gateway also blocks `/api/setup/*` for every request, including valid sessions. Keys come from
  host secrets, never from a browser panel.
- **Paid routes stay off.** `/api/realtime/*` and `/api/openai/*` return 404. The Google Maps and OpenAI
  keys stay unset.
- **Path checks.** The gateway refuses encoded slashes, encoded dot segments, backslashes, and
  protocol-relative targets. It forwards the same normalized path it checked.
- **Logs.** The gateway never logs a query string, a cookie, or a secret.

If the browser still drops the cookie, the embedded page tells the dashboard. The dashboard then points
you to **Open full screen**, which loads the host as a top level page where the cookie always works.

## Secrets and settings

Secrets live in the host's secret store. Never put a value in git, a URL, or a chat.

| Name | Where | Needed | Purpose |
| --- | --- | --- | --- |
| `GEV_SHARED_SECRET` | Render secret and Worker secret (the same value) | Yes | Signs and checks access tokens. Use 32 or more random characters. |
| `CESIUM_ION_TOKEN` | Render secret | No | Free Cesium ion token. Without it the globe uses the keyless basemap. |
| `GEV_FRAME_ANCESTORS` | Render variable (the blueprint sets it) | No | Space separated dashboard origins. Defaults to `https://shreyas-tech7.github.io`. |
| `GEV_CLIENT_IP_HEADER` | Render variable (the blueprint sets it) | On Render | Header that carries the real client address. `cf-connecting-ip` on Render. |
| `GEV_APP_HEAP_MB` | Render variable | No | V8 heap cap for the app process. Defaults to 256. |
| `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`, `TOMTOM_API_KEY`, `FIRMS_MAP_KEY`, `AISSTREAM_API_KEY`, `LL2_API_TOKEN` | Render secrets | No | Optional free provider keys. The globe works without them. |
| `HF_TOKEN`, `HF_SPACE_ID` | GitHub secret and variable | Only for Hugging Face | Used by the optional sync to a Hugging Face Space (needs PRO). |

Restrict the Cesium ion token under **Allowed URLs** to the host origin. A Cesium ion token is meant for
browsers, so treat it as a quota guard and not as a secret.

The app process never sees `GEV_SHARED_SECRET`, `HF_TOKEN`, or the paid OpenAI and Google keys.

Other tuning variables: `GEV_SESSION_IDLE_SECONDS`, `GEV_SESSION_MAX_SECONDS`, `GEV_RATE_API_PER_MIN`,
`GEV_RATE_UNAUTH_PER_MIN`, `GEV_MAX_BODY_BYTES`, and `GEV_TRUST_PROXY_HOPS`. See `server/config.mjs`.

## Deploy on Render (free, no card)

1. Sign in at <https://dashboard.render.com> and connect your GitHub account.
2. Choose **New**, then **Blueprint**, pick this repository, and apply `render.yaml`. It creates a free Docker
   web service named `titan-gev`.
3. Render asks for two values. Paste `GEV_SHARED_SECRET` (the same value that the Worker holds) and, if you have
   one, `CESIUM_ION_TOKEN`. Leave the Cesium field blank to use the keyless basemap.
4. Wait for the first build. It takes a few minutes. Read the service URL on the Render page. It is
   `https://titan-gev.onrender.com` unless the name was taken.
5. Set the dashboard repository variable `GEV_URL` to that URL and redeploy the dashboard.
6. Run the live checks below.

Render deploys again when a commit on `main` passes its GitHub checks. A free service sleeps after 15 idle
minutes and wakes in about a minute. The dashboard tab shows a waking state and retries on its own.

## Verify the live host

After the service is live, run the live checks from your own terminal.

```bash
npm run verify:live -- https://titan-gev.onrender.com
```

The script asks for `GEV_SHARED_SECRET` with hidden input, so the value never reaches shell history, process
arguments, or output. It checks that no token returns 401, a valid token returns 200, an expired token and a
reused token are rejected, `frame-ancestors` names only the dashboard, Provider Settings and the paid voice
route return 404, and no response contains the secret. A sleeping host gets up to three minutes to wake.

Then open the dashboard tab and confirm that the globe loads.

## Optional: a Hugging Face Space

A Docker Space needs a PRO plan. If you have one, create a Docker Space, add the secrets, and add the GitHub
secret `HF_TOKEN` (plus the variable `HF_SPACE_ID` when the Space is not `Cozmik7/titan-gev`). The **Build and
sync** workflow then uploads the build inputs with the Hub upload API. It never force pushes. Without
`HF_TOKEN` the sync job skips with a notice.

## Update the upstream version

1. Pick a commit from <https://github.com/bilawalsidhu/gods-eye-view>.
2. Put its full 40 character hash in `UPSTREAM_COMMIT`.
3. Open a pull request. The build check installs, runs `npm run doctor`, builds, and runs the gate tests
   against the new commit.
4. Merge. Render deploys the new image.

## Codespaces fallback

The `.devcontainer` folder starts Node 24, fetches the pinned upstream, and runs `npm ci`. Use it when
you want the globe on demand.

```bash
npm run dev:codespace
```

This runs the upstream dev server on `0.0.0.0:4173` with port 4173 forwarded. For the gated wrapper, run
the next command, which listens on port 7860.

```bash
npm run upstream:build && npm start
```

Set `CESIUM_ION_TOKEN` and `GEV_SHARED_SECRET` as Codespaces secrets. The names also appear in
`devcontainer.json`.

Two limits apply:

- **Codespaces sleeps when idle.** The globe disappears until you start the Codespace again.
- **A private forwarded port cannot be embedded in TITAN.** GitHub asks the viewer to sign in, and a
  third party iframe cannot complete that. The port would have to be public, and then the dev server
  has no gate. So Render is the host the tab uses.

## Test it

```bash
npm test
```

The unit tests cover the token format, the path rules, the config, the rate limiter, and the gateway over
real HTTP with a fake clock. The smoke test runs the real gateway in front of the real built app.

```bash
npm run upstream:fetch
npm run upstream:build
npm run smoke
```

The smoke test stops everything it starts.

## License

The files in this repository use the MIT license. God's Eye View and its data keep their own terms.
See [NOTICE.md](NOTICE.md).
