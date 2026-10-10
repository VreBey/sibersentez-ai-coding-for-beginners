---
name: deploy-web
description: "Puts a website or web app online: picks a host, checks the build, publishes a preview link first, sets environment variables, then goes live after a clear yes, with a custom domain if wanted. Use when the user wants to put the site online, share a link, publish a web page, or connect a domain name to the project."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.3.1"
  sibersentez-checked: "2026-10-09"
  sibersentez-tags: "devops, web"
  sibersentez-stage: "ship"
  sibersentez-keywords-tr: "internete koy*, canlıya al*, online yap*, alan adı, domain, hosting, vercel, netlify, linki paylaş*"
---

# Deploy web

Publishing is the moment work becomes visible to strangers, so go in two stages: a **preview** link only the user
looks at, then **live** after a clear yes. The host details, exact commands and links are in [reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- Deploying, signing in to a host, and anything that costs money always need their own yes. Never enter payment
  details for the user, and never type a password or key into a command or the chat.

## 1. What is being published?

- **Static**: plain files or a build that produces a folder of files (a landing page, a site that needs no server).
- **Needs a server**: server-side rendering, an API, a database. Some hosts run this, some do not.

Read `PLAN.md` and the README. Ask what the user expects to pay (nothing is fine) and whether they have a domain.

## 2. Choose a host

Offer two options that fit, and recommend one. Prices and free limits change often, so read the host's current
pricing page instead of quoting from memory, and tell the user you checked (or could not).

| The project | Options to look at |
|---|---|
| Plain static files | GitHub Pages, Netlify, Cloudflare Pages, Vercel |
| Next.js or a site with server code | Vercel, Netlify (check the framework's own deployment guide) |
| A separate API service | a host that runs Node.js or Python apps; check its documentation |
| A hosting plan with a control panel (cPanel, Plesk) the user already pays for | static files: upload them; an app: the panel's Node.js or Python manager. See "Hosting with a control panel" in the reference |
| Full control, a container, or a host that only runs containers | Docker on a rented server (a VPS): see "Docker on a VPS" in the reference; the container itself is `docker-basics` |

## 3. Before publishing

1. The build passes here: run the build command and show the result (`fix-build-errors` if not).
2. Nothing secret is in the code: read `security-check` if unsure. Real values go in the host's settings, not in files.
3. Make a list of the environment variable **names** from `.env.example` (never their values).
4. The project is committed (`git status`), so the deploy matches saved work.

## 4. Preview first (a yes to sign in, a yes to deploy)

Use the host's command-line tool. Connecting the GitHub repository in the host's dashboard is a bigger step: after
it, every push to the main branch can go live, so it needs its own clear yes first (say that plainly), and a preview
with the command-line tool comes before it. The reference has the commands and the warning for each host. Signing in opens a browser window: the user does
that themselves. Say plainly: "This makes a test link. Nothing goes live yet."

On panel hosting, the preview is a temporary subdomain, kept out of search engines. Ask the user to open the preview
link, on their phone too. Together check: the page loads, images show, links work,
and features that need settings work (a missing variable often shows as a blank page or an error).

## 5. Environment variables

The user enters values in the host's dashboard (the section for environment variables), then the project is
deployed again. In the chat, only names appear. Values that start with the public prefix of the framework
(`NEXT_PUBLIC_`, `VITE_`) end up in the browser: they must never be secret. Use test keys for previews.

## 6. Go live (a clear yes, once more)

Ask: "The preview looks right. Publish it for everyone at the live address?" Only after a yes, run the host's
production step from the reference. Then open the live address, repeat the checks of step 4, and go through
`launch-checklist` (one HTTPS address, headers, legal pages, 404, sitemap).

## 7. A domain name (optional)

Buying a domain costs money and is done by the user at a registrar. Then add the domain in the host's dashboard and
create the DNS records the host shows, at whichever DNS host the domain's name servers point to (records added
anywhere else do nothing). Moving the name servers moves **every** record: copy mail and verification records first.
It can take from minutes to a day; check from several public resolvers, not only your own computer. The secure address
(HTTPS) is issued by the host. Check in the host's documentation for the exact records.

## 8. Leave a trail

Write the live address, the host and the redeploy command in the README. Explain rollback: hosts keep earlier
deployments, and the dashboard can make an older one live again.

## Do not use for

- Version number, changelog and release notes: use `release-prep`.
- The checks right before and after going live: `launch-checklist`. Email at the domain: `domain-email`.
- Moving a site that already runs somewhere else: `move-to-new-host`.
- Tests on every push: use `github-actions-setup`.
- Keys and `.env` files: use `env-and-secrets`; a leaked key: `secrets-cleanup`.
- Making the container image: use `docker-basics`; running it on your own server is the "Docker on a VPS" section of the
  reference. Other server setups (clusters, cloud consoles): read the provider's documentation.

## Done when

- The build result was shown, and a preview address was printed and opened by the user (quote the address).
- Environment variable names were listed and set by the user; the checks of step 4 were done on the preview.
- If the user said yes to live: the production command ran, and `curl.exe -I <address>` (or `curl -I` outside
  PowerShell) shows a `200` status line.
- You told the user in one sentence where the site lives and how to publish a change again.
