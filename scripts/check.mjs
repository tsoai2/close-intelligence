// Static checks that run without any network access:
//   1. syntax check of every server, script and test file (node --check)
//   2. type check of the pure calculation modules (tsc --checkJs, strict)
//   3. source hygiene rules (the stand-in for a linter in this offline setup)
//   4. production client build
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolPath = process.env.CI_NODE_PATH || path.join(root, 'node_modules');
let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failed++; console.log('  ✗ ' + m); };
const walk = (dir, out = []) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { if (['node_modules', 'data', 'shots', 'assets'].includes(f.name)) continue; const p = path.join(dir, f.name); if (f.isDirectory()) walk(p, out); else out.push(p); } return out; };

console.log('Syntax');
const js = ['server', 'scripts', 'tests', 'client'].flatMap(d => walk(path.join(root, d))).filter(f => /\.(js|mjs)$/.test(f));
let syntaxBad = 0;
for (const f of js) { const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }); if (r.status !== 0) { syntaxBad++; bad(path.relative(root, f) + '\n' + r.stderr.split('\n').slice(0, 5).join('\n')); } }
if (!syntaxBad) ok(`${js.length} JavaScript files parse`);

console.log('Types (pure calculation modules, strict)');
const tsc = path.join(toolPath, 'typescript', 'bin', 'tsc');
const typed = ['decimal', 'calendar', 'schedule', 'csv', 'similarity'].map(n => path.join(root, 'server', 'lib', n + '.js'));
if (!fs.existsSync(tsc)) bad('TypeScript not found. Run npm install, or set CI_NODE_PATH to a folder containing typescript.');
else { const r = spawnSync(process.execPath, [tsc, '--noEmit', '--allowJs', '--checkJs', '--strict', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--skipLibCheck', ...typed], { encoding: 'utf8', cwd: root }); if (r.status === 0) ok(`${typed.length} modules type-check`); else bad('type errors\n' + (r.stdout + r.stderr).split('\n').slice(0, 40).join('\n')); }

console.log('Source hygiene');
const src = ['server', 'client/src', 'scripts'].flatMap(d => walk(path.join(root, d))).filter(f => /\.(js|mjs|jsx)$/.test(f) && !f.endsWith('check.mjs'));
const rules = [
  [/\bdebugger\b/, 'debugger statement'],
  [/sk-[A-Za-z0-9_-]{20,}/, 'something that looks like an API key'],
  [/localStorage\.setItem\([^)]*(key|token|secret)/i, 'a secret written to browser storage'],
  [/\beval\(|new Function\(/, 'dynamic code evaluation'],
  [/dangerouslySetInnerHTML/, 'raw HTML injection'],
  [/\b(gpt-[0-9]|o[0-9]-(mini|preview)|text-davinci)/, 'a hard-coded OpenAI model name'],
];
let hygiene = 0;
for (const f of src) { const text = fs.readFileSync(f, 'utf8'); for (const [re, what] of rules) if (re.test(text)) { hygiene++; bad(`${path.relative(root, f)}: ${what}`); } }
const clientSrc = walk(path.join(root, 'client', 'src')).map(f => fs.readFileSync(f, 'utf8')).join('\n');
if (/OPENAI_API_KEY|CI_SECRET_KEY|api\.openai\.com/.test(clientSrc)) { hygiene++; bad('client source refers to server-side secrets or calls OpenAI directly'); }
if (!hygiene) ok(`${src.length} source files pass ${rules.length + 1} rules`);

console.log('Build');
const b = spawnSync(process.execPath, [path.join(root, 'client', 'build.mjs')], { encoding: 'utf8', cwd: root, env: process.env });
if (b.status === 0) { const bundle = fs.readFileSync(path.join(root, 'public', 'assets', 'app.js'), 'utf8'); if (/OPENAI_API_KEY|CI_SECRET_KEY/.test(bundle)) bad('built bundle mentions a server secret name'); else ok(`client bundle built (${Math.round(bundle.length / 1024)} kB)`); } else bad('client build failed\n' + (b.stdout + b.stderr).slice(0, 1500));

console.log(failed ? `\n${failed} check(s) failed.` : '\nAll static checks passed.');
process.exit(failed ? 1 : 0);
