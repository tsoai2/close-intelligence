import { createServer } from './app.js';
import { dbFor, wipeDemo } from './db.js';
import { port, usingLocalKey, APP_VERSION } from './config.js';
import { seedDemo } from './seed/demo.js';

const args = process.argv.slice(2);
if (args.includes('--reset-demo')) { wipeDemo(); const r = seedDemo(dbFor('demo'), 'baseline'); console.log('Demo reseeded:', r); process.exit(0); }
dbFor('live'); const demo = dbFor('demo'); // runs migrations for both environments
if (!demo.get('SELECT 1 x FROM orgs LIMIT 1')) { const r = seedDemo(demo, 'baseline'); console.log(`Demo seeded: ${r.tasks} tasks in the current period, ${r.documents} documents, ${r.findings} findings.`); }
if (args.includes('--migrate-only')) { console.log('Migrations applied for demo and live.'); process.exit(0); }
const server = createServer();
server.listen(port(), () => {
  console.log(`CLOSE INTELLIGENCE ${APP_VERSION} running at http://localhost:${port()}`);
  if (usingLocalKey()) console.log('Note: using a local development key file for secret encryption. Set CI_SECRET_KEY for any shared deployment.');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); });
