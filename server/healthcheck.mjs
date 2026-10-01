// Docker HEALTHCHECK. Asks the gateway on its own port, whatever the host set.
import { loadConfig } from './config.mjs';

const { listenPort } = loadConfig(process.env);
try {
  const response = await fetch(`http://127.0.0.1:${listenPort}/healthz`, { signal: AbortSignal.timeout(4000) });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
