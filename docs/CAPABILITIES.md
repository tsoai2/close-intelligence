# Capability matrix

Three honest categories:

- **Verified** — built, and exercised by an automated check in this repository.
- **Needs external configuration** — built as far as possible without an account or
  credential that was not available; not confirmed against the real service.
- **Deferred** — not built. Where the app mentions it, it says "not connected".

Verification run (offline build environment, Node 22, headless Chrome):
`npm run check` passed; `npm test` 38 of 38; `npm run test:e2e` 23 of 23 with no browser
console or page errors; screenshots reviewed at 1440, 1024 and 390 px wide in dark and
light themes. Demo detection against the truth manifest: 14 of 14 planted issues found,
0 missed, protected document not flagged for retirement, plus 6 additional candidates
that were not planted (listed in `docs/demo-truth-manifest.json`; some follow from the
planted data, some are false positives for a person to dismiss).

## Verified

| Area | What works |
| --- | --- |
| Demo / Live | One switch; separate databases, file stores and sessions; stale responses from the other environment are rejected; Demo reset and scenario changes never touch Live; Live starts empty. |
| Sign-in and roles | Live: first-administrator setup, email + password, add people, change/reset password, deactivate. Seven roles enforced on the server. Demo: role preview without passwords. |
| Navigation and interface | Today, Close, Process Map, Documents, Insights, Reports; Settings menu; contextual assistant panel; dark and light themes; command palette (Ctrl/⌘ K or /); saved views; bulk task actions; undo for imports and recent task changes; save-state indicator; reduced motion; keyboard path through the graph plus a table alternative; phone layout with bottom navigation. |
| Close setup | Entities, calendars (Day 0, business-day offsets, holidays, 4-4-5 preview), versioned templates with validation and publish, standard and optional distributor template library, period creation and rollover (assignments and instructions carried forward; evidence and sign-offs fresh). |
| Tasks | States with enforced transitions, steps, evidence requirements, dependencies, discussion, history, optimistic concurrency with a conflict dialog, preparer ≠ reviewer with a recorded small-team exception. |
| Dependencies and schedule | Finish-to-start and start-to-start with lag; cycles rejected on the server with an explanation; critical path, slack, projected completion with stated assumptions and coverage; dependency-only and one-task-per-person projections shown separately. |
| What-if | Read-only sandbox; compare against the current plan; save; explicit publish. |
| Requests and handoffs | Request lifecycle, expected dates, reminders as drafts, calendar (.ics) files, restricted external portal, waiting tasks released on acceptance. |
| Reconciliations | Workpaper with reconciling items and aging, version-bound approval, automatic "re-review required" when source balances change. |
| Journals | Draft → Approved → Confirmed posted (manual confirmation; nothing is posted to an ERP), balanced-entry validation, export. |
| Trial balance import | CSV and XLSX wizard: column mapping, preview, validation (unbalanced, unknown accounts, duplicates), commit, rollback. Checklist import the same way. |
| Financials | Trial balance, variance with thresholds and explanations, income statement and balance sheet per entity and consolidated with translation and intercompany elimination, intercompany matching. Integer minor-unit arithmetic throughout. |
| Completion | Sign-off chain, lock, reopen with reason, exception register. |
| Documents | Upload with versions, checksums, text extraction (CSV, XLSX, DOCX, text-based PDF), links to tasks/controls/requests, usage log, duplicate and near-duplicate detection, classification with owner confirmation, archive only after confirmation, never deleted automatically, protected-document rule. |
| Rules engine | 18 deterministic rules; each finding carries evidence, coverage, confidence, limitations and control implication; dismissals persist. |
| Improvements | Proposal → Under review → Approved → Pilot → Implemented → Validated / Rejected; capacity hours and cash kept separate; overlapping savings flagged rather than double-counted. |
| Reports and exports | Close status report, PDF package, Excel workbook, CSV exports with formula-injection protection, JSON backup. |
| Assistant without a key | Answers from permitted records by fixed rules, with citations; labelled "sample" in Demo and "AI not connected" in Live. |
| Feedback | Form → preview → Outlook compose link (work/school or Outlook.com) addressed to the fixed recipient, with mail-app and copy fallbacks; never reports "sent". Verified by intercepting the URL; no real message was sent. |
| Audit | Append-only, hash-chained log with an in-app integrity check. |

## Needs external configuration

| Area | State | What is needed |
| --- | --- | --- |
| OpenAI connection | Key entry, encrypted storage, connection test, model list fetched from the account (no model names in the code), Responses API call with a strict schema, retries, timeout, cancel, spend estimate and limits, citation and action filtering — all exercised against a **local stand-in** for the OpenAI API. **Not run against the real service.** It uses direct HTTPS calls, not the official SDK. | An OpenAI API key (API billing is separate from a ChatGPT subscription). Press Test in Settings → AI connection and confirm a real answer before relying on it. |
| Outlook draft | The compose link format is the commonly used Outlook on the web deep link; Microsoft does not publish it as a supported interface. Verified only that the app opens the correct URL. | Click Feedback once with your account. If your tenant handles the link differently, use the "Open in my email app" or copy fallback. |
| Shared deployment | Runs anywhere Node 22 runs; secure-cookie, secret-key and data-folder settings exist. No deployment was performed. | HTTPS, `CI_SECRET_KEY`, persistent disk, backups, access restriction — see `docs/DEPLOYMENT.md`. |
| Malware scanning | Hook exists; uploads are marked "not scanned". | A scanner service. |

## Deferred

| Area | Note |
| --- | --- |
| ERP connection (including any Sage product) | Not built. No connector is claimed. Trial balances come in by file. A connector should be written only against a confirmed product, edition and API. |
| ERP write-back (posting journals, locking periods) | Deliberately excluded. |
| Microsoft 365 / SharePoint / OneDrive / Teams | Not built. Documents are uploaded; no usage data is read from Microsoft 365, which is why in-app views are never treated as proof of use. |
| Sending email or reminders | Not built by design: drafts only. |
| Single sign-on (Entra ID) and multi-factor sign-in | Interface file only (`server/adapters/sso.js`). |
| PostgreSQL, multiple instances, object storage | SQLite and local disk, single process. |
| TypeScript, ESLint, Tailwind, component/chart/graph libraries, official OpenAI SDK | Not used: no package registry was reachable during the build. JavaScript with JSDoc types (strict-checked for the calculation modules only), a small hygiene checker, hand-written CSS and SVG. |
| OCR for scanned PDFs and images | Not built; such files are stored and marked "no text extracted". PDF text extraction is basic and can miss text in complex files. |
| Background processing | Only findings analysis runs through the job queue; imports and text extraction run during the request. |
| Drag and drop | Not built (reordering and linking use forms and keyboard). |
| Offline use | Not built by design; the app needs the server. |
| Time zones | One organization time zone; no per-user time zones. |
| Consolidation depth | Closing/average-rate translation with the translation difference shown as a computed balancing amount. No historical-rate equity, minority interest or multi-level ownership. |
| Cash flow statement, statutory or tax reporting | Not built. |
| Independent security review, accessibility audit, load testing | Not performed. Automated checks cover keyboard paths, focus, reduced motion and touch-target size only. |

## Things the app will not claim

- A document with no views in this app is "no usage observed here", never "unused".
- Projected dates are estimates from recorded durations and dependencies, with their
  coverage shown, never commitments.
- Time savings on improvements are entered or estimated by people and labelled as such;
  capacity hours are not converted to cash.
- Demo figures, names and documents are fictional and exist only in Demo.
