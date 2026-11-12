// Writes the demo truth manifest and a few of the generated synthetic workpapers into
// docs/ and samples/ so they can be inspected without starting the app.
// Uses a throwaway data directory; it never touches data/demo or data/live.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-samples-'));
process.env.CI_DATA_DIR = tmp;
const { dbFor, getFile, closeAll } = await import('../server/db.js');
const seed = await import('../server/seed/demo.js');

const db = dbFor('demo');
if (!db.val("SELECT count(*) FROM sqlite_master WHERE name='orgs'")) throw new Error('Schema missing: run the server once or check server/migrate.js');
if (!db.val('SELECT count(*) FROM orgs')) seed.seedDemo(db, 'baseline');
const org = db.get('SELECT * FROM orgs LIMIT 1');

const out = path.join(root, 'samples', 'workpapers'); fs.mkdirSync(out, { recursive: true });
const wanted = ['%Inventory%Reconciliation%', '%Intercompany%', '%Covenant%', '%Bank%', '%Close Procedure%', '%Sales by Customer%', '%Accrual%'];
const seen = new Set(); let n = 0;
for (const like of wanted) {
  const v = db.get('SELECT v.filename, v.storage_key FROM document_versions v JOIN documents d ON d.id=v.document_id WHERE d.org_id=? AND d.title LIKE ? ORDER BY v.id LIMIT 1', org.id, like);
  if (!v || seen.has(v.filename)) continue; seen.add(v.filename);
  const buf = getFile('demo', org.id, v.storage_key); if (!buf) continue;
  fs.writeFileSync(path.join(out, v.filename), buf); n++;
}
const check = seed.checkManifest(db, org.id);
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'demo-truth-manifest.json'), JSON.stringify({
  note: 'Issues deliberately planted in the fictional demo data, and what the rules engine reported for the default scenario. Everything here is synthetic.',
  company: org.name, demoClock: seed.DEMO_NOW, scenarios: seed.DEMO_SCENARIOS, planted: seed.MANIFEST, defaultScenarioResult: check,
}, null, 2));
console.log(`Wrote ${n} sample workpapers to samples/workpapers and docs/demo-truth-manifest.json`);
closeAll(); fs.rmSync(tmp, { recursive: true, force: true });
