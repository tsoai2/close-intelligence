# Use it in a browser, with nothing installed

The app is a small server plus a web page. To use it from a browser without installing
anything on your computer, the server has to run somewhere else. Two ways to do that:

## Option A — GitHub Codespaces (quickest, for demonstrations)

GitHub runs the app on a private cloud machine tied to your GitHub account and opens it
in a browser tab. Nothing is installed on your computer. GitHub's free allowance covers
occasional use; the machine sleeps when idle.

1. Put this folder in a private GitHub repository (github.com → New repository → Private,
   then "uploading an existing file" and drag the unzipped folder's contents in).
2. On the repository page choose **Code → Codespaces → Create codespace on main**.
3. Wait about a minute. A terminal shows `CLOSE INTELLIGENCE … running`, and the app opens
   in a new browser tab. If it does not, open the **Ports** tab and click the globe icon
   beside port 4600.
4. Next time: github.com/codespaces → open the same codespace. Your Demo changes and any
   Live data are still there until you delete the codespace.

To let someone else open the link (for example a client following along), right-click
port 4600 in the Ports tab → Port Visibility → Public. Leave it Private otherwise.

This set-up (`.devcontainer/devcontainer.json`) was written for this purpose but has
**not been run on GitHub** as part of verification. If the page opens but saving fails
with "Cross-site request rejected", tell the developer: the forwarded host header needs
adjusting in that file.

A codespace is fine for showing Demo. Do not keep real close data in one: it is a
development machine, with no backups and a development-grade secret key.

## Option B — a permanent address for a team

Host it on a server or a container service (Azure App Service, Render, Fly, an internal
VM) behind HTTPS. `Dockerfile` in this folder is a starting point and
`docs/DEPLOYMENT.md` has the checklist: HTTPS, secret key, persistent disk, backups,
restricted access. This needs someone with access to your hosting account.

## What stays the same

`npm start` on your own computer still works exactly as before.
