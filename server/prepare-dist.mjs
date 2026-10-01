// Build-once, configure-at-start. The image builds the app with a placeholder in
// place of the Cesium ion token, so the secret never lands in an image layer. At
// container start this copies the build and swaps the placeholder for the real
// token from the host's secret store.
import fs from 'node:fs';
import path from 'node:path';

export const CESIUM_PLACEHOLDER = '__GEV_CESIUM_ION_TOKEN__';

const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.html', '.css', '.json']);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // The Cesium runtime assets are large and never carry the placeholder.
      if (entry.name === 'cesium' || entry.name === 'models') continue;
      yield* walk(full);
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

/**
 * Copy `srcDir` to `destDir` and replace the placeholder with `token`.
 * An empty token turns the placeholder into an empty string, which is the
 * app's keyless path. Returns counts only. The token value is never returned or logged.
 */
export function prepareRuntimeDist({ srcDir, destDir, token = '' }) {
  if (!fs.existsSync(path.join(srcDir, 'index.html'))) {
    throw new Error(`build output not found in ${srcDir}`);
  }
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.cpSync(srcDir, destDir, { recursive: true });
  let filesChanged = 0;
  let occurrences = 0;
  for (const file of walk(destDir)) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(CESIUM_PLACEHOLDER)) continue;
    const parts = text.split(CESIUM_PLACEHOLDER);
    occurrences += parts.length - 1;
    fs.writeFileSync(file, parts.join(token));
    filesChanged += 1;
  }
  return { filesChanged, occurrences, tokenApplied: token !== '' && occurrences > 0 };
}
