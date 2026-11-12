// Bundles the React client into public/assets. Uses local node_modules when present; in an offline
// environment set CI_NODE_PATH to a directory that contains esbuild, react and react-dom.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
const root = path.resolve(import.meta.dirname, '..');
const extra = process.env.CI_NODE_PATH ? [process.env.CI_NODE_PATH] : [];
const require = createRequire(extra[0] ? path.join(extra[0], 'x.js') : path.join(root, 'package.json'));
let esbuild; try { esbuild = require('esbuild'); } catch { esbuild = createRequire(path.join(root, 'package.json'))('esbuild'); }
const dev = process.argv.includes('--dev');
await esbuild.build({ entryPoints: [path.join(root, 'client/src/main.jsx')], bundle: true, format: 'esm', outfile: path.join(root, 'public/assets/app.js'), jsx: 'automatic', minify: !dev, sourcemap: dev ? 'inline' : false, target: ['es2022'], nodePaths: extra, define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"' }, logLevel: 'info', legalComments: 'none' });
fs.copyFileSync(path.join(root, 'client/src/styles.css'), path.join(root, 'public/assets/app.css'));
console.log('Client built.');
