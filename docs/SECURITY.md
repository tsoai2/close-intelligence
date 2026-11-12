# Security model and its limits

## What is enforced, and where

| Area | How |
| --- | --- |
| Environment isolation | Demo and Live use different database files, file folders and cookies. The API path and an `X-CI-Env` header must agree or the request is rejected. Demo reset deletes only the demo folder. A Demo role preview creates a session in the demo database only; it is not a Live session. |
| Sign-in | Passwords hashed with scrypt and a per-user salt. Sessions are random tokens, stored hashed, in HttpOnly SameSite=Strict cookies (Secure when `CI_SECURE_COOKIES=1`). Sign-in, password change and AI requests are rate-limited. Deactivating a person, changing their role or resetting their password ends their sessions immediately. |
| Request forgery | State-changing requests need a per-session CSRF token header and an Origin that matches the Host. |
| Authorization | Checked on the server for every route by role permission, then by organization on every record load. Outside contributors can reach only portal routes and only their own requests. Hidden buttons are a convenience, not the control. |
| Segregation of duties | A preparer cannot approve their own task, reconciliation or journal. A documented small-team setting allows it and records each instance as an exception. |
| Approvals | Immutable rows bound to the version reviewed and the version of the source data. A later change does not alter the approval; it marks the item "re-review required". |
| Audit log | Append-only. Each event stores a hash of the previous event; database triggers reject UPDATE and DELETE; Settings → Audit log verifies the chain. |
| Files | Stored outside the web root by content hash. Downloads go through a permission check and a short-lived signed link, and are sent as attachments. Uploads are limited to 20 MB and an allow-list of types whose content must match the extension. Restricted documents are visible only to permitted roles, including in search and AI retrieval. |
| Exports | CSV cells starting with `=`, `+`, `-`, `@`, tab or carriage return are prefixed so spreadsheet programs do not run them as formulas. Backups exclude password hashes, sessions and API keys. |
| Browser | Content-Security-Policy without inline script, `X-Frame-Options: DENY`, `nosniff`, strict referrer policy. No secrets in browser storage; only the theme and a few view preferences are kept there. |
| OpenAI key | Live and Demo each hold their own key, in their own database; a key saved in Demo is never used by Live and the server-wide `OPENAI_API_KEY` is never used by Demo. Demo makes no OpenAI call until a key is saved there. Entered once by an administrator (in Demo, also the close manager persona), encrypted with AES-256-GCM under `CI_SECRET_KEY`, never returned to the browser (only the last four characters as a hint), never logged or exported. Calls are made from the server only. |
| AI behaviour | Document and email text is passed as quoted data with an instruction that it is untrusted. Output must match a strict schema; citations to records that were not supplied are removed; proposed actions outside a fixed allow-list are removed. The assistant has no route to approve, delete, send, change permissions, post journals or lock a period; anything it proposes is a draft a person must carry out. Requests use `store: false`. Administrators choose which document classes may be sent; restricted documents are excluded by default. |
| Feedback | The draft is built in the browser and contains only what the form shows: type, your text, an optional contact line you enter, screen name, app version, environment and browser (the context lines can be switched off). No balances, documents, other people's details or screenshots. The recipient is fixed. The app reports "draft opened", never "sent". |

## Limits you should know

- **Audit tamper-resistance is not tamper-proof.** The hash chain and triggers stop
  changes through the application and make casual edits detectable. Someone with write
  access to the database file can drop the triggers and rebuild the chain. For stronger
  assurance, ship audit events to an external write-once store; that is not built.
- **The secret key is only as safe as where you keep it.** With `CI_SECRET_KEY` unset, a
  development key file is written next to the data, which protects nothing if the folder
  is copied. Set the key from a secret manager for any shared deployment. There is no KMS
  integration and no key-rotation tool; rotating means re-entering saved secrets.
- **Anyone who can open Demo can use a key connected there.** Demo has no sign-in: role preview is open to whoever reaches the address. On a shared address, a key linked in Demo can be used (not read) by any visitor through the assistant, up to the spending stop. Link a key in Demo only on your own machine or a private address, set a low limit, and disconnect it afterwards.
- **No malware scanning.** Uploads are recorded as "not scanned". A scanner hook exists
  (`scanHook` in `server/domains/documents.js`) but nothing is connected to it.
- **No single sign-on or multi-factor authentication.** Passwords only. Restrict network
  access to the site until SSO is implemented (`server/adapters/sso.js` is an interface,
  not an implementation).
- **Rate limits are per process and reset on restart.**
- **Prompt-injection defences reduce risk; they do not eliminate it.** The structural
  protection is that the assistant cannot take actions, and that its citations are
  checked against what it was given.
- **Database encryption at rest** is not provided by the app; use disk or volume
  encryption on the host.
- **No independent security review or penetration test has been performed.**

## Reporting a problem

Use the Feedback button (type: Bug) and do not include passwords, keys or real balances.
