/**
 * _load-env.ts — shared .env loader for the apps/api/scripts/ tree.
 * Searches:
 *   1. <repo-root>/.env  (the dev server uses this)
 *   2. cwd/.env
 *   3. node_modules/.env (uncommon)
 *
 * Already-set env vars are NOT overwritten (so the caller can pass
 * overrides via `DATABASE_URL=... node ...`).
 *
 * Imported as a side-effect module: just `import './_load-env.js'`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  path.resolve(SCRIPT_DIR, '..', '..', '..', '.env'), // repo root
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '..', '..', '.env'),
];

for (const candidate of CANDIDATES) {
  if (!existsSync(candidate)) continue;
  const text = readFileSync(candidate, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const m = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!;
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
  break;
}