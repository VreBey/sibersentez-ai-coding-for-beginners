# Move to a new host: reference

Written 2026-10-05 from moving a small Node.js shop from a rented Linux server (nginx in front, a systemd service) to a
cPanel shared hosting plan (LiteSpeed web server, Passenger for Node.js), with about six minutes of downtime and no
data lost. Panel names differ between hosts; the shape stays the same.

## Inventory commands on the old Linux server (read-only)

```bash
systemctl cat <service-name>          # start command, user, working folder, environment file path
node --version                        # or python3 --version
ls -la <app-folder>                   # code and data folders
cat /etc/nginx/sites-enabled/*        # redirects, headers, upload limit, proxy port
crontab -l                            # scheduled jobs
du -sh <data-folder>                  # how big the data is
```

Read the environment file only to list its **names**: `cut -d= -f1 <env-file>`.

Backup in one archive, then copy it to the user's computer with `scp` (the user's own SSH key, never a password in a
command):

```bash
tar -czf /tmp/site-backup-YYYY-MM-DD.tar.gz <app-folder> <env-file> <nginx-config>
sha256sum /tmp/site-backup-YYYY-MM-DD.tar.gz
```

Then remove the archive from `/tmp` on the old server after the copy is checked (it holds secrets), with a yes.

## DNS before the switch

Export the whole zone from the current DNS host (most have "export" or a zone file view). Check against it after the
switch, record by record. Typical records people forget: `www`, `MX`, SPF, DKIM (`*._domainkey`), DMARC, search
console `TXT`, subdomains for other services.

When the name servers move, the registrar change can take minutes to hours, and resolvers keep the old answers until
their copy expires. While both answers are in use, both places must serve the site (or redirect to it).

## Shared hosting: static files

Zip the built folder, upload the zip with the panel's file manager, extract it into the site's document root, delete
the zip. Keep the `.htaccess` blocks the panel wrote ("do not edit" markers); put your own rules above them.

## Shared hosting: a Node.js app (cPanel "Setup Node.js App", Passenger)

| Item | Note |
|---|---|
| Application root | a folder **outside** the public document root, so source files are never served |
| Startup file | a small file that loads the app, for example `app.js` with `require('./server.cjs')` |
| Port | the app listens on the port the platform gives (`process.env.PORT`), not a fixed one |
| Environment variables | set in the app's page of the panel; the user types secret values |
| Data folder | outside the app folder too, so a redeploy cannot overwrite it; pass its path as a variable |
| Restart | the panel's restart button, or create or touch `tmp/restart.txt` in the app root |
| Logs | `stderr.log` in the app root, and the panel's error log |
| `npm install` | the panel's "Run NPM Install" button, which uses the app's own Node.js version |

Things that behaved differently from the old server:

- **The visitor's IP address.** Behind Passenger the socket address can be empty or the local proxy. Read the first
  address of `X-Forwarded-For` **only** when the request came from the local proxy; otherwise anyone can fake it.
  Rate limits and login lockouts that count by IP depend on this.
- **Headers** that nginx added (HSTS, compression) are gone: add them in `.htaccess` (`launch-checklist` reference).
- **An addon domain may not pick up the panel's app settings.** If the domain shows a file list instead of the app,
  the app's lines can be put into that domain's `.htaccess` (`PassengerAppRoot`, `PassengerBaseURI`, `PassengerNodejs`,
  `PassengerAppType node`, `PassengerStartupFile`); check the host's documentation first.
- **Adding a domain** to the panel can be refused while its name servers point elsewhere; move the name servers first
  (or ask the host to add it), after copying every record.

## Comparison outline

| Check | Old | New |
|---|---|---|
| `/` status and title | 200, "…" | 200, "…" |
| Every sitemap address answers 200 | yes | yes |
| Count of products (or rows) from the public page or API | 42 | 42 |
| Images on the shop page loaded / total | 70/70 | 70/70 |
| Errors in the browser console | none | none |
| Admin sign-in (the user) | works | works |
| Private files (`.env`, data folder) answer 404 | yes | yes |

## After the switch

```powershell
foreach ($r in '8.8.8.8','1.1.1.1','9.9.9.9') { nslookup example.com $r }
curl.exe -sI https://example.com/
```

If an old CDN or DNS account still has a copy of the zone, make it match the new records (or delete the zone there with
the user's yes), because some resolvers may still ask it for a while.

## Problems

| Symptom | Usual cause |
|---|---|
| The domain shows a list of files or the host's default page | the app is not attached to that domain yet; see the addon note above |
| Everyone shares one login lockout or rate limit | the IP is read from the empty socket; read `X-Forwarded-For` from the local proxy |
| Some visitors see the old site for hours | resolvers keep old answers until the TTL runs out; keep the old site up or redirecting |
| The panel says the domain does not point here | the panel's own resolver; check from outside, tell the host if it lasts |
| Data written during the switch is missing | changes were not stopped before the last copy; copy the difference by hand |
| Resources feel smaller than the plan promised | compare the panel's resource page with the offer and ask the host |
