# Deploy web: reference

Checked 2026-09-30 (revisit every six months). Hosts change commands, names and free limits: the official page is
the truth, this file only shows the shape. The commands below come from the hosts' documentation; the author of this
kit did not deploy to each host, so read what the tool prints and stop at anything unexpected.

Official pages:

- Vercel, command-line tool: https://vercel.com/docs/cli ; deployments: https://vercel.com/docs/deployments
- Netlify, command-line tool: https://docs.netlify.com/cli/get-started/ ; deploys: https://docs.netlify.com/site-deploys/overview/
- GitHub Pages: https://docs.github.com/en/pages
- Cloudflare Pages: https://developers.cloudflare.com/pages/
- Domains and DNS: each host's documentation, section "custom domain".

## Two ways to deploy

1. **Connect the repository.** In the host's dashboard choose "new project", pick the GitHub repository, and check
   the build command and output folder it suggests. **Warning: once connected, every push to the main branch can go
   live for everyone, and the first build may publish right away.** Branches and pull requests get a preview
   address. Get the user's separate, explicit yes for this before connecting, or choose a production branch that is
   not the main branch in the host's settings. If in doubt, publish a preview with the command-line tool first
   (option 2).
2. **Command-line tool**. Run from the project folder. The first run asks to sign in through the browser and to link
   the project. `npx` downloads the tool the first time: needs a yes.

## Vercel

| Goal | Command |
|---|---|
| Preview deployment | `npx vercel` |
| Production deployment (after a yes) | `npx vercel --prod` |
| List environment variables (names) | `npx vercel env ls` |

Environment variables are added in the dashboard (Project, Settings, Environment Variables), and each can be limited
to Preview or Production. Framework settings (build command, output folder) are detected for common frameworks.

## Netlify

| Goal | Command |
|---|---|
| Preview (draft) deploy | `npx netlify-cli deploy` (asks for or takes the folder to publish) |
| Production deploy (after a yes) | `npx netlify-cli deploy` with its production option |

The command-line package is called `netlify-cli`. The flags for the folder and for production differ between
versions: check the official docs (the CLI page linked above) before you run it, and read what it prints.

The output folder is the built folder (for example `dist` or `build`) or the folder of plain files. Sites without a
build step use the folder that holds `index.html`. Environment variables are in the dashboard (Site configuration,
Environment variables).

## GitHub Pages

Static files only. In the repository: Settings, Pages, then choose the source: a branch and folder, or GitHub
Actions for a build step. The address looks like `https://<user>.github.io/<repository>/`; a project site lives in
a sub-path, so links and asset paths must work from there. Environment variables do not exist for static Pages:
never put a secret in a static site.

## Cloudflare Pages

Connect the repository in the dashboard, or upload the built folder. For the command-line route read the current
"Direct Upload" page in the documentation before running anything.

## Hosting with a control panel (cPanel and similar)

Added 2026-10-05 from publishing a static site and a Node.js app on a cPanel shared hosting plan. Many people already
pay for such a plan with their domain. There is no command-line tool: the work is in the panel's pages, which the user
opens (they sign in themselves). Before anything, compare the plan's real limits on the panel's resource page (memory,
processes, CPU) with what was sold.

- **Static site**: build it, zip the output folder, upload the zip in the File Manager into the domain's document root
  (`public_html` for the main domain, its own folder for an extra domain), extract, delete the zip. Keep the blocks the
  panel wrote in `.htaccess` (marked "do not edit") and put redirects and headers above them (`launch-checklist`
  reference has the lines).
- **Preview**: a subdomain such as `test-<random>.example.com` pointing at its own folder; remove it after going live.
- **Node.js or Python app**: the panel's application manager ("Setup Node.js App" in cPanel). Application root outside
  the document root, a small startup file, environment variables typed by the user in that page, a data folder outside
  the app folder, restart by touching `tmp/restart.txt`. Details and pitfalls: `move-to-new-host` reference.
- **HTTPS**: the panel issues a free certificate by itself (AutoSSL, Let's Encrypt) once DNS points at the server; it
  renews alone.
- **Email** comes with the plan: `domain-email`.
- **Paid extras** offered at checkout (search engine "registration", a firewall panel) are usually not needed for a
  small site: registering with a search engine is free in its own console, and HTTPS and the panel's firewall are
  included. Say what each would add before the user pays.

## Environment variables

| Rule | Why |
|---|---|
| Names in the chat, values only in the host's dashboard | values in a chat or file can leak |
| Variables with the public prefix (`NEXT_PUBLIC_`, `VITE_`) are readable by every visitor | never put a secret behind them |
| Use test-mode keys for previews and live keys only for production | a preview must not spend real money |
| Change a variable, then deploy again | most hosts read it at build time |

## Custom domain

1. The user buys the domain at a registrar (their own payment).
2. Add the domain in the host's dashboard; it shows the DNS records to create (an `A` or `CNAME` record).
3. The user creates those records at the registrar. Wait for the host to say the domain is verified.
4. HTTPS is issued by the host by itself once DNS points at it.

## Problems

| Symptom | Usual cause |
|---|---|
| Blank page online, fine here | a missing environment variable, or a wrong base path (common on GitHub Pages) |
| The build fails online only | different runtime version or a missing lock file: see `github-actions-setup` |
| A 404 on a page refresh | a single-page app needs the host's "rewrite all to index.html" setting: check the host's documentation |
| The new version does not show | a cache: hard refresh; check that the right branch was deployed |
| Images or styles missing | file paths that start with `/` while the site lives in a sub-path |
| Domain does not work yet | DNS takes time; check the records against the host's page |

## Docker on a VPS

For when the user wants full control, the app needs a server of its own (a long-running process, a database file,
a bot), or a host only runs containers. A VPS is a small rented computer on the internet. This is more work and more
responsibility than the hosts above: say so, and say it costs a monthly fee. Steps that change the server are done in
the user's own terminal or with their explicit yes each time; never enter their password or key for them.
Official pages: https://docs.docker.com/engine/install/ , https://caddyserver.com/docs/ , and the provider's own
getting-started guide. The commands below show the shape; the pages are the truth.

1. **Before the server**: the project has a working `Dockerfile` and `compose.yaml` (`docker-basics`), settings read from
   the environment, and a plan for where data lives (a volume) and how it is backed up.
2. **The server**: the user rents one from a provider of their choice (a small Linux server is enough) and notes its
   address. They sign in with an SSH key, not a password: `ssh-keygen` makes the key pair on their computer (the private
   file stays there), the provider's panel takes the public file.
3. **Safe basics on the server** (the user runs them; read each line to them first): create a normal user instead of
   working as the main administrator, switch off password sign-in, turn on the firewall allowing only SSH, HTTP and
   HTTPS, turn on automatic security updates. The provider's guide shows the commands for its system.
4. **Docker on the server**: follow Docker's install page for that Linux system (not a copy of a command from memory).
5. **Put the project there**: copy it with `git clone` from a repository, or copy the files; create the `.env` on the
   server by hand (values typed there, never in a chat or in git).
6. **Start it**: `docker compose up -d --build`, then `docker compose ps` and `docker compose logs`.
7. **A name and HTTPS**: point a domain's DNS record at the server's address (see "Custom domain" above), and put a
   small web server in front that gets certificates by itself. A short Caddy file does it:

```
example.com {
    reverse_proxy app:3000
}
```

   Caddy runs as another service in the same `compose.yaml`; `app` is the name of the app's service and `3000` its port.
   The app's own port is not opened to the internet, only the web server's 80 and 443.
8. **Prove it**: open `https://example.com` on a phone, then `curl.exe -I https://example.com` shows a `200` line.
9. **Update later**: on the server, `git pull`, then `docker compose up -d --build`. Check the logs. To go back, check out
   the previous commit and run it again.
10. **Keep it alive**: back up the data volume or database file somewhere else on a schedule and test restoring once;
    update the system and the base images regularly; watch the disk space (`docker system df`).

| Symptom | Usual cause |
|---|---|
| The domain shows nothing | DNS has not spread yet, or points at the wrong address; check the record. |
| Browser says the certificate is wrong | the domain does not reach the server yet, or ports 80 and 443 are closed in the firewall. |
| `502 Bad Gateway` | the app is not running or listens on another port: `docker compose logs app`. |
| Cannot connect over SSH | wrong user or key, or the firewall blocks SSH: use the provider's web console to look. |
| The server runs out of disk | old images and logs. Look at `docker system df`, and clean only after a yes. |
| The app forgets its data after an update | data was in the container, not in a volume. Move it to a volume before the next update. |
