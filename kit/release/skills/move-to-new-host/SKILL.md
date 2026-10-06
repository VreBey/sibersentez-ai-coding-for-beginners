---
name: move-to-new-host
description: "Moves a running site or web app to another host without losing data: a read-only look at the old server, a full backup, setup at a test address, a side-by-side comparison, a short planned switch of DNS, checks from several places, and the old server kept until the new one is proven. Use when the user changes hosting or wants to leave a server."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.0"
  sibersentez-tags: "devops, web"
  sibersentez-stage: "ship"
  sibersentez-keywords-tr: "hosting değiştir*, sunucu değiştir*, siteyi taşı*, sunucu taşı*, sunucuyu taşı*, hostinge taşı*, başka hostinge, vps kapat*, vds kapat*"
---

# Move to a new host

A move is safe when the old place keeps working until the new one has proven itself. Copy, compare, switch in one
short planned step, check from outside, and only then let the old server go. Shared hosting details, DNS commands
and a comparison outline are in [reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- The old server is only **read** until the switch is done. Its data is never deleted by you; cancelling a server or a
  plan costs or saves money and is the user's own action.
- Secret values (the `.env` file, API keys) are copied as files to the user's computer and to the new host's settings,
  never shown in the chat. Use names only when talking about them.

## 1. Inventory of the old place (read-only)

Write down: what runs (static files, Node.js, Python, PHP), the runtime version, the start command, the port, the
environment variable **names**, where data lives (folders, a database, uploads), scheduled jobs, what the web server in
front adds (redirects, headers, compression, upload size limits), who else works there (a teammate's remote session),
and **every DNS record** of the domain, including mail and verification `TXT` records. Count what matters: products,
users, images, rows.

## 2. Can the new host run it?

Static sites run anywhere. An app needs the host's app support: on shared hosting, the panel's Node.js or Python
manager. Check the real limits in the panel (memory, processes, CPU) against what was sold, and say what will not
work there (long-running background jobs, websockets, no SSH). If the app cannot run, say so before anything moves and
offer options (a smaller rewrite, a different plan); never start a rewrite without a yes.

## 3. A full backup

Code, data, uploads, the environment file and the web server config, packed with a date in the name, copied to the
user's computer, with its size and a checksum noted. Say plainly where it is.

## 4. Set up at a test address

Use a temporary subdomain on the new host. Upload the code and the data copy, set the environment variables (the user
types the values), start the app. The test address must not be indexed: send `noindex` or keep it secret.

## 5. Compare side by side

Same pages, same status codes, same counts (products, images), same look on a phone. Forms and sign-in are tried by the
user. Fix what the new host does differently, for example the visitor's IP address behind a proxy, headers the old web
server added, file permissions or paths. Write each difference and its fix.

## 6. Plan the switch

Agree a time with little traffic and say how long it may be unreachable. If the domain's DNS host stays the same, lower
the TTL of the records a day before. If the name servers move to the new host, first copy **every** record there
(mail, verification, subdomains). Right before the switch, stop changes on the old site and copy the data once more.

## 7. Switch (a clear yes)

Point the domain at the new host (an `A` record, or the name servers), add the domain in the new panel, get the
certificate, set the one-address redirect, set the public address variable of the app. Remove the test address when
done.

## 8. Prove it from outside

Several public resolvers return the new address; the site answers `200` with HTTPS; counts match; the user tries it on a
phone over mobile data; mail still arrives. Then run `launch-checklist`, since headers and redirects often change with a
host. Places that still hold old DNS answers (a CDN or DNS account that was used before) are updated to match or
cleared, so late visitors land on the new site too.

## 9. Let the old place go

Keep the old server a few days. Take a final backup. Write down the new workflow for anyone who worked on the old
server (how to update the site now). Then the user cancels the old plan.

## Do not use for

- A first deploy: `deploy-web`. Mail setup at the new place: `domain-email`.
- Containers on a rented server: `docker-basics` and "Docker on a VPS" in `deploy-web`'s reference.

## Done when

- The backup exists on the user's computer with its size and checksum.
- The comparison table shows the same pages, codes and counts on the new host, with every difference fixed or listed.
- After the switch, at least three public resolvers and a phone reach the new site over HTTPS, and mail works.
- You told the user in one sentence what changed, where the backup is, and what only they must do (cancel the old
  plan, inform teammates).
