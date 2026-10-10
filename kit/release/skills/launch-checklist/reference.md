# Launch checklist: reference

Contents: Redirects · Headers · Apache or LiteSpeed (`.htaccess`, common on shared hosting) · DNS from more than one
place · Link checker (Node.js 22 or newer, no packages) · Page tags · Legal pages: an outline to start from · Problems

Written 2026-10-05 from a real launch of two small sites (a static site and a Node.js shop) on shared hosting. Commands
are for Windows PowerShell (`curl.exe`, `nslookup`); outside PowerShell write `curl` instead of `curl.exe`. Replace
`example.com` with the user's address.

## Redirects

```powershell
foreach ($u in 'http://example.com','http://www.example.com','https://www.example.com') {
  curl.exe -s -o NUL -w "%{http_code} %{redirect_url}`n" $u
}
```

Every line should be `301 https://example.com/` (or the `www` form if that is the chosen address).

## Headers

```powershell
curl.exe -sI https://example.com/            # a page
curl.exe -sI https://example.com/style.css   # a static file
curl.exe -sI https://example.com/nothing-here # must be 404
```

| Header | Good value | Note |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000` | add only when every address already redirects to HTTPS |
| `X-Content-Type-Options` | `nosniff` | |
| `X-Frame-Options` / CSP `frame-ancestors` | `DENY` / `'none'` | unless the site must be shown inside another site |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | |
| `Content-Security-Policy` | starts with `default-src 'self'` | a page without scripts can say `script-src 'none'` |
| `Content-Encoding` | `br` or `gzip` | on HTML, CSS and JavaScript |
| `Cache-Control` | long for files, short or `no-cache` for pages | |

To test a new server before DNS points at it, pin the address to its IP:
`curl.exe -sI --resolve example.com:443:<new-server-ip> https://example.com/`

## Apache or LiteSpeed (`.htaccess`, common on shared hosting)

Keep any block the hosting panel wrote (it is marked "do not edit"); add yours above it.

```apache
RewriteEngine On
RewriteCond %{HTTPS} !=on [OR]
RewriteCond %{HTTP_HOST} !^example\.com$ [NC]
RewriteRule ^ https://example.com%{REQUEST_URI} [L,R=301]

<IfModule mod_headers.c>
Header always set Strict-Transport-Security "max-age=31536000"
Header always set X-Content-Type-Options "nosniff"
Header always set Referrer-Policy "strict-origin-when-cross-origin"
</IfModule>
ErrorDocument 404 /404.html
```

On nginx the same lines are `return 301 https://example.com$request_uri;` in the port-80 server block and
`add_header Strict-Transport-Security "max-age=31536000" always;` in the HTTPS one. A Node.js or Python app can also set
headers itself; then check that the web server in front does not drop them.

## DNS from more than one place

Different people use different resolvers. A site can open for you and fail for others.

```powershell
foreach ($r in '8.8.8.8','1.1.1.1','9.9.9.9') { nslookup example.com $r }
```

Run it a few times. If one resolver fails now and then while the others answer, the cause is usually at the name
servers of the domain (for example two name servers on the same single address). That is for the DNS host's support:
send them the times, the resolver and the error text.

## Link checker (Node.js 22 or newer, no packages)

Save as `check-links.mjs` outside the published folder and run `node check-links.mjs https://example.com`.

```js
const base = process.argv[2].replace(/\/$/, '');
const xml = await (await fetch(base + '/sitemap.xml')).text();
const pages = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const seen = new Map();
for (const page of pages) {
  const html = await (await fetch(page)).text();
  for (const m of html.matchAll(/\s(?:href|src)="([^"#]+)"/g)) {
    if (/^(mailto|tel|data|javascript):/.test(m[1])) continue;
    const u = new URL(m[1], page);
    if (u.origin === new URL(base).origin && !seen.has(u.href)) seen.set(u.href, page);
  }
}
let bad = 0;
for (const [u, from] of seen) {
  const r = await fetch(u, { method: 'HEAD', redirect: 'manual' });
  if (r.status >= 400) { bad++; console.log(r.status, u, 'on', from); }
}
console.log(pages.length, 'pages,', seen.size, 'links,', bad, 'broken');
```

It sends one request per link, one at a time: gentle enough for a small site.

## Page tags

```html
<html lang="tr">
<title>Product name: what it does</title>
<meta name="description" content="One or two sentences, about 150 characters.">
<link rel="canonical" href="https://example.com/page/">
<meta property="og:title" content="Product name">
<meta property="og:description" content="One sentence.">
<meta property="og:image" content="https://example.com/og.png">
<meta name="twitter:card" content="summary_large_image">
```

`robots.txt`:

```
User-agent: *
Allow: /
Sitemap: https://example.com/sitemap.xml
```

## Legal pages: an outline to start from

Privacy policy: who runs the site and how to reach them; what is collected (forms, orders, server logs, cookies); why
and on which legal basis; how long it is kept; who else receives it (hosting, payment, mail, analytics); the visitor's
rights (Turkey: KVKK article 11; EU: GDPR) and where to send a request; the date of the last change. Terms: what the
site offers, prices and payment, delivery and returns for a shop, liability limits, the applicable law. A shop in
Turkey also needs a distance sales contract and a pre-information form shown before payment; the payment provider
usually lists what it requires.

## Problems

| Symptom | Usual cause |
|---|---|
| A header is on the static files but not on the app's pages (or the other way round) | two layers answer: set it in both, or in the one in front |
| HSTS disappeared after moving hosts | the old web server added it; add it on the new one |
| The 404 page answers `200` | the server serves the page as a normal file; use the server's error-document setting |
| The hosting panel says "DNS not resolving" but the site opens everywhere | the panel's own resolver; check with the commands above, then tell the host |
| The search console cannot verify | the TXT record went to the wrong DNS host: the one in charge is whoever the name servers point to |
| Shared links show no picture | `og:image` missing, not absolute, or the image is too small |
