# Developer setup

## Requirements

- Node.js **22.13+** (uses the built-in `node:sqlite`, `node:test`, `fetch`).
- No runtime dependencies. `npm install` is only needed to rebuild the client or run the
  static and browser checks (esbuild, react, typescript, playwright).

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Applies migrations for Demo and Live, seeds Demo if empty, serves on `PORT` (4600). Reads `.env` if present. |
| `npm run dev` | Rebuilds the client, then runs the server with `--watch`. |
| `npm run build` | Bundles `client/src` into `public/assets/app.js` and `app.css`. |
| `npm run migrate` | Applies migrations and exits. |
| `npm run seed:demo` | Wipes and reseeds Demo only. Never touches Live. |
| `npm run check` | Syntax check, strict type check of the calculation modules, source hygiene rules, client build. |
| `npm test` | Unit and integration tests (`node:test`), 38 tests. Each file starts its own server on a temporary data folder. |
| `npm run test:e2e` | 23 browser checks in headless Chrome via Playwright, including the seven user journeys. Uses a local mock for OpenAI and intercepts Outlook URLs; nothing leaves the machine. |
| `node scripts/export-samples.mjs` | Regenerates `samples/workpapers/` and `docs/demo-truth-manifest.json`. |

If the dev tools live outside `./node_modules`, set `CI_NODE_PATH` to that folder, and
`CI_CHROME` to a Chrome executable for the browser tests.

## Architecture in one page

- **One process.** `server/app.js` is a small router over `node:http`. Routes are
  registered with `route(method, pattern, { perm }, handler)` in `server/domains/*`.
  Every request is resolved to an environment (`/api/demo/...` or `/api/live/...`), a
  session, an organization and a permission before the handler runs.
- **Two environments, physically separate.** `data/demo/app.db` + `data/demo/files` and
  `data/live/app.db` + `data/live/files`; separate cookies (`ci_demo_sid`, `ci_live_sid`).
  The browser sends `X-CI-Env` on every call and the server rejects a mismatch (409), so
  a response prepared for one environment is never applied in the other. On switching,
  the client aborts in-flight requests, clears its cache and bumps an epoch counter.
- **Money** is stored as integer minor units and parsed/translated with BigInt
  (`server/lib/decimal.js`). No floating point in balances, differences or translation.
- **Time** is stored as naive local date-times in the organization's time zone.
  `server/lib/calendar.js` does working-day arithmetic (Day 0, BD offsets, holidays, 4-4-5).
- **Scheduling** (`server/lib/schedule.js`): finish-to-start and start-to-start links with
  lag and a "prepared" or "approved" gate; cycle detection; forward and backward pass in
  working minutes; critical path as a driver chain; optional one-task-at-a-time-per-person
  pass. `server/engine.js` feeds it from the database and explains the result.
- **Approvals** are immutable rows bound to the version of the work and the version of
  its source data. Changing either leaves the old approval in history and marks the item
  for re-review. Database triggers reject UPDATE and DELETE on approvals and the audit log.
- **Concurrency.** Editable records carry a `version`; writes send `expectedVersion` and
  get 409 with the current record if someone else saved first.
- **Rules engine** (`server/rules.js`): deterministic findings, each with evidence, data
  coverage, confidence, limitations and a fingerprint so dismissals stick.
- **AI** (`server/domains/ai.js`): builds a context of records the user is allowed to see,
  calls the OpenAI Responses API over HTTPS with a strict JSON schema, then drops any
  citation that is not in that context and any proposed action not on the allow-list.
  With no key (or in Demo) the same question is answered by fixed rules and labelled.
- **Client.** React 19, hand-written CSS design system (`client/src/styles.css`), SVG
  graph and charts, no component or chart libraries. Routing is path + query string;
  drawers are URL-addressable (`?task=`, `?doc=`…).

## Adding things

- **A migration:** add `server/migrations/00N_name.sql`; migrations run in filename order
  and are recorded per database.
- **A route:** `route('POST', '/things/:id', { perm: 'task:edit' }, ctx => …)`. Use
  `ctx.own(table, id)` to load a record (it enforces the organization boundary),
  `ctx.audit(...)` for anything that changes state, `ctx.changed(...)` to notify other
  open browsers.
- **A rule:** add a function to `computeFindings` in `server/rules.js` that returns
  findings with `evidence`, `coverage`, `confidence` and `limitations`. If it corresponds
  to something planted in the demo, add it to `MANIFEST` in `server/seed/demo.js`; the
  integration tests compare detections against the manifest.
- **A connector:** see `server/adapters/README.md`.

## Deliberate differences from a conventional stack

The build environment had no package registry access, so the app is written against the
Node standard library. Consequences, all listed in `docs/CAPABILITIES.md`:
SQLite instead of PostgreSQL; JavaScript with JSDoc types instead of TypeScript; a
rules-based hygiene check instead of ESLint; direct HTTPS calls to OpenAI instead of the
official SDK; hand-written xlsx/docx/pdf/zip readers and writers (`server/lib/files.js`).
