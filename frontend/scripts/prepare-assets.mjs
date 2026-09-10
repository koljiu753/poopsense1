import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A normal Git checkout already contains these files. A source-only deployment
// can fetch the exact, previously published brand assets without embedding them
// in an API request. Checksums apply to downloaded files, not local edits.
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("./public-assets.json", import.meta.url), "utf8"));
mkdirSync(publicDir, { recursive: true });
const missing = manifest.files.filter(file => !existsSync(`${publicDir}${file.name}`));
for (let offset = 0; offset < missing.length; offset += 4) {
  await Promise.all(missing.slice(offset, offset + 4).map(async file => {
    const response = await fetch(`${manifest.source}/${encodeURIComponent(file.name)}`, { signal: AbortSignal.timeout(90000) });
    if (!response.ok) throw new Error(`Unable to fetch ${file.name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error(`Asset checksum mismatch: ${file.name}`);
    writeFileSync(`${publicDir}${file.name}`, bytes);
  }));
}
console.log(`Brand assets ready (${manifest.files.length} files; ${missing.length} fetched).`);
