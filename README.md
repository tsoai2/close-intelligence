# CLOSE INTELLIGENCE

A month-end close workspace: one place to run the checklist, see what is holding the
date, tie approvals to the exact version of the work that was reviewed, keep the
supporting documents, and find repeatable ways to make the next close shorter.

It ships with two fully separate environments behind one switch:

- **Demo** — a fictional distributor (three entities, four periods, about 110 tasks per
  period, 15 people, about 90 real downloadable synthetic files) with planted problems
  to explore. Nothing in Demo is real, and Demo never sends anything or calls OpenAI.
- **Live** — starts empty. You create the first administrator account, import your own
  checklist and trial balance, and invite your team.

## Run it

Requires **Node.js 22.13 or newer**. There is nothing to install: the server has no
runtime dependencies and the browser bundle is pre-built.

```
npm start
```

Then open <http://localhost:4600>. The first start creates the databases and seeds Demo.

## Where to go next

| If you want to… | Read |
| --- | --- |
| Try it as a finance user, no technical background | [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) |
| See honestly what is built, what needs configuration, what is deferred | [docs/CAPABILITIES.md](docs/CAPABILITIES.md) |
| Change the code, run the checks | [docs/DEVELOPER.md](docs/DEVELOPER.md) |
| Put it on a server for a team | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| Understand the security model and its limits | [docs/SECURITY.md](docs/SECURITY.md) |
| See the problems planted in the demo data | [docs/demo-truth-manifest.json](docs/demo-truth-manifest.json) |

## Layout

```
server/            Node server (no dependencies): API, auth, scheduling, rules, exports
  migrations/      Database schema
  seed/            Template library and the fictional demo company
  lib/             Pure calculation modules (money, calendars, critical path, CSV, files)
  domains/         API routes by area (tasks, financial, documents, insights, reports, ai…)
  adapters/        Interfaces for services that are not connected yet (single sign-on)
client/src/        React interface (bundled into public/assets by `npm run build`)
public/            What the browser loads
samples/           Import templates and example synthetic workpapers
tests/             Unit, integration and browser checks
docs/              Guides, capability matrix, demo truth manifest
```

The standard and distributor checklists in the template library are illustrative
starting points. They are not statements about any real company's process.
