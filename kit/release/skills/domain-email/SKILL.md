---
name: domain-email
description: "Sets up email at the project's own domain: a few chosen addresses, mailboxes the user creates with their own passwords, SPF, DKIM and DMARC, forwarders, auto-replies and spam settings, then a real send and reply test whose authentication results are read. Use when the user wants an address like info@ their domain, or their mail lands in spam."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.0"
  sibersentez-tags: "devops, web"
  sibersentez-stage: "ship"
  sibersentez-keywords-tr: "kurumsal eposta, kurumsal mail, kurumsal posta, posta kur*, mail kur*, posta adresi aç*, spf, dkim, dmarc, spama düş*, webmail"
---

# Domain email

An address at the site's own domain looks trustworthy and stays with the project when people change. It only works
if the receiving side believes the mail is really from that domain, so the records matter as much as the mailboxes.
Records, ports and panel names are in [reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- **Passwords are the user's.** They create each mailbox and its password themselves, ideally in a password manager.
  Never suggest, type, store or write a password into a file or the chat, not even "to make it easier".
- Sending a message on the user's behalf, even a test, needs a yes and a recipient the user named.

## 1. Which addresses

Fewer is better: each mailbox is something to read. A usual small set:

| Address | For |
|---|---|
| `info@` or `hello@` | the public address on the site |
| `support@` (`destek@`) | questions from users |
| `privacy@` (`kvkk@`) | personal data requests the privacy policy promises to answer |
| `security@` (`guvenlik@`) | security reports; named in `SECURITY.md` and on the site |
| `orders@` (`siparis@`) | a shop's order mail |

Propose real mailboxes only where someone answers; the rest can be **forwarders** into one mailbox. Avoid personal
names in public addresses.

## 2. Who hosts the mail

The domain's `MX` record decides where mail goes: the hosting panel's own mail, or a mail provider. Only one. Read the
current `MX`, `TXT` and name servers (reference) before changing anything, and say which service will receive mail.

## 3. Mailboxes (the user)

Guide the user to the panel's email accounts page; they create each mailbox and its password. A small quota is fine
to start. Then you can continue with everything that needs no password.

## 4. The three records

- **SPF** (a `TXT` on the domain): which servers may send for it. Exactly one SPF record; it lists every sender
  (the host, a newsletter service, the shop's mail service).
- **DKIM**: the panel or provider makes a key and shows a `TXT` record; publish it and check it is "valid".
- **DMARC** (a `TXT` at `_dmarc`): what receivers do when SPF and DKIM fail. Start with `p=none`, move to
  `p=quarantine` once tests pass.
- A matching reverse DNS (`PTR`) for the sending server is the host's job; if the panel warns about it, the user asks
  the host.

## 5. Routing, forwarders, spam

- Set mail routing for the domain to **local** when the mail is hosted on the same server (to **remote** when a provider
  handles it). "Automatic" guesses from DNS and can guess wrong when the server's own DNS lookups fail.
- Mail to unknown addresses is **rejected**, not collected (a catch-all fills with spam).
- Forwarders for the secondary addresses; spam filter on, spam moved to a folder, not deleted.
- An auto-reply only where it helps (privacy and security addresses: "received, we answer within N days"). Promise
  only what the user can keep.

## 6. Webmail and signature

In webmail: the sender name (the product, not a person, unless the user wants that), a short signature with the site
address, the time zone. Two webmail sessions in one browser often sign each other out: use a private window for the
second, or an email app over IMAP.

## 7. Test, with a yes

1. From each sending address, send one short test to an outside mailbox the user named (for example their Gmail).
2. The user (or you, if they allow reading that one message) opens it with "Show original": SPF, DKIM and DMARC must
   each say **PASS**, and the message must be in the inbox, not spam.
3. The user replies from the outside mailbox; check it arrives in the domain mailbox (and through each forwarder).

## 8. Use it

Replace personal addresses in the site, the legal pages, structured data, `SECURITY.md` and the README with the new
ones. Write the mail server names and ports (no passwords) in the project notes.

## Do not use for

- Sending mail from code (sign-up mails, order mails): the app's mail service and its keys, `env-and-secrets`.
- The site's other launch checks: `launch-checklist`. Moving mail with a whole site: `move-to-new-host`.

## Done when

- The chosen addresses exist (mailboxes or forwarders), and the user created every password themselves.
- SPF, DKIM and DMARC are published once each and the panel shows them valid.
- A test from each sending address arrived in an outside inbox with SPF, DKIM and DMARC PASS, and a reply came back.
- You told the user in one sentence which addresses exist, where they read them, and what only they can do next.
