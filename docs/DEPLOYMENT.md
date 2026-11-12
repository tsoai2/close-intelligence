# Deployment

The app is a single Node process with its data in one folder. That makes a small
internal deployment simple, and it also sets the limits described at the end.

## Local "Live" versus a shared deployment

Running `npm start` on your own computer and switching to Live is fine for evaluation:
it is a real, separate, persistent database. It is not a team deployment. Before real
close data and more than one person use it, complete the checklist below.

## Readiness checklist

1. **Host.** Any Linux/Windows host or container with Node 22.13+. One instance only
   (sessions, rate limits and the job runner are in-process).
2. **HTTPS.** Put it behind a reverse proxy or platform that terminates TLS (nginx,
   Caddy, Azure App Service, Fly, Render…). Then set `CI_SECURE_COOKIES=1`. The proxy must
   pass the original `Host` and `Origin` headers; state-changing requests whose Origin
   does not match the Host are rejected.
3. **Secret key.** Generate a 32-byte key and supply it as `CI_SECRET_KEY` from the
   host's secret manager — not in the repository and not in the data folder:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
   Losing it means saved secrets (the OpenAI key) must be re-entered. Rotating it has the
   same effect.
4. **Persistent disk.** Point `CI_DATA_DIR` at a persistent, access-restricted volume.
5. **Backups.** See below. Test a restore before go-live.
6. **First administrator.** Open the site, switch to Live, create the workspace. Do this
   immediately after deploying: until it is done, the first visitor can claim it.
7. **Restrict access.** Until single sign-on is implemented, limit who can reach the site
   (VPN, IP allow-list or the platform's access control) in addition to passwords.
8. **OpenAI (optional).** Settings → AI connection, or `OPENAI_API_KEY` in the
   environment. Press Test and select a model from the returned list. Set the monthly
   spending stop and per-person hourly limit there, and set usage limits in the OpenAI
   account as well (the in-app stop is an estimate, not a billing cap).
9. **Run the checks** on the host: `npm test`.

## Backup and restore

Everything for Live is under `CI_DATA_DIR/live`:

- `app.db` (plus `app.db-wal` / `app.db-shm` while running) — all records.
- `files/` — uploaded documents, stored by content hash.

**Backup.** Preferred: stop the process, copy the `live` folder, start it again.
Without downtime: `sqlite3 app.db ".backup '/backups/app-YYYYMMDD.db'"` and copy `files/`
(files are never modified in place, so copying them live is safe). Keep the secret key
backed up separately from the data.

**Restore.** Stop the process, replace `CI_DATA_DIR/live` with the backup copy (database
file named `app.db`, no stale `-wal`/`-shm` files), start with the same `CI_SECRET_KEY`.

**Export.** Reports → JSON backup produces a readable export of the organization's
records (no password hashes, no API key, no file contents). It is for portability and
audit, not a restore mechanism.

Demo lives in `CI_DATA_DIR/demo` and can be deleted or reseeded at any time
(`npm run seed:demo`); doing so never touches Live.

## Container example

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY samples ./samples
ENV CI_DATA_DIR=/data PORT=4600 CI_SECURE_COOKIES=1
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 4600
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
```

Supply `CI_SECRET_KEY` at run time from the platform's secret store. This file is an
example and has not been built or run as part of verification.

## Limits to know before relying on it

- **Single instance, SQLite.** Appropriate for one finance team. Moving to PostgreSQL
  and multiple instances means porting `server/db.js` and the SQL, and moving sessions,
  rate limits and jobs out of process. Not done.
- **Files on local disk.** No object storage adapter yet, and no malware scanner is
  connected: uploads are validated by type and size and marked "not scanned".
- **No email, no SSO, no ERP or Microsoft 365 connection.** See `docs/CAPABILITIES.md`.
- **Health check:** `GET /api/health`.
