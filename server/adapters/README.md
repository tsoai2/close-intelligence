# Adapters

Interfaces for services that need a real account before they can be built and tested.
Nothing in this folder is connected. The Integrations screen reports each of these as
"not configured" until an implementation exists and its connection test has passed.

| File | Purpose | Status |
| --- | --- | --- |
| `sso.js` | Single sign-on (OpenID Connect, for example Microsoft Entra ID) | Interface only. Email and password sign-in is active. |

Rules for anything added here:

- Build against one named product, API version and tenant that has been verified. Do not write a generic "Sage" or "ERP" adapter.
- Start read-only. Write-back (journal posting, period lock) is a separate, separately permissioned integration.
- Credentials are stored with `encryptSecret` from `server/config.js`, never returned to the browser, never logged.
- The connection status shown to users must come from a real test call, with the time it last succeeded.
