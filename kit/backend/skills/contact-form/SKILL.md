---
name: contact-form
description: "Adds a contact, booking or order form that really reaches someone: on a site with no server through a form service or the host's mail, on an app through its own backend. Covers required fields, spam protection, a privacy note, a thank-you state and a real test message. Use when a site needs a contact, reservation or order form."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.1"
  sibersentez-checked: "2026-10-09"
  sibersentez-tags: "web, backend, security"
  sibersentez-stage: "build"
  sibersentez-keywords-tr: "iletişim formu, rezervasyon formu, sipariş formu, bize ulaşın, form gönder*, form eposta*, formdan mail, mesaj formu, başvuru formu"
---

# Contact form

A form that looks right but sends nothing is worse than no form: people think they wrote to you. The goal is one form
whose messages arrive in a mailbox someone reads, with no password or key in the page.

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- **No secret in the page.** A mail password, an SMTP login or a private API key never goes into HTML, JavaScript or
  any file the browser downloads. Accounts with a form service are the user's: they sign up, you never do.
- Sending a test message needs a yes and an address the user named.

## 1. Where the messages should go

Ask two things: which address receives the messages (it must exist and be read), and what the form is for (contact,
booking, order). Then pick the way that fits what the project already is:

| The project | Use | Why |
|---|---|---|
| Plain pages (HTML/CSS, no server), any host | a form service (Formspree, Web3Forms, Forminit (formerly Getform) or the like) | the form posts to the service, it mails the user; nothing to run |
| Netlify or a host with its own form feature | the host's forms | no extra account |
| A shared host with PHP and mail (cPanel and the like) | a short PHP handler on the same host | mail leaves from the domain; set up `domain-email` first |
| An app with its own server | a route in that server that validates and sends | the key stays on the server |

Say the choice and its cost in one sentence (most services are free up to a monthly number of messages).

## 2. The fields

Few fields get more answers. Usual sets:

- Contact: name, email, message.
- Booking: name, phone or email, date, time, number of people, a note.
- Order: name, phone, address (only if delivered), what and how many, a note.

Every field has a visible label (not only a placeholder), the right type (`email`, `tel`, `date`), `required` where it
must be filled, and an error that says what to fix. Keep the person's text if sending fails.

## 3. Spam and abuse

- A hidden "honeypot" field that people never fill; the service or handler drops messages that have it.
- The service's own protection, or a CAPTCHA only if spam still gets through (it costs real people effort).
- On a server: limit how often one address may send, and check every field again there (the page's checks are for
  people, not for protection). Never mail the person's text as HTML; escape it.

## 4. Privacy

Collect only what the form needs. Add one sentence near the button saying what happens with the data and link the
privacy page if the site has one (KVKK in Turkey, GDPR in the EU). No pre-ticked boxes.

## 5. After sending

Show a clear thank-you state on the same page ("Message sent, we answer within a day"), turn the button off while
sending, and show a plain error with another way to reach you (phone, email) when sending fails.

## 6. Test it for real

1. Fill the form with test data and send it.
2. Check the mailbox (and its spam folder) together with the user: did it arrive, is the reply-to the sender's address?
3. Send once with an empty required field and once with a wrong email: the form must stop and say why.
4. On a phone-sized window: the fields and the button are usable.

## Do not use for

- Accounts, sign-in and stored user data: use `auth-flow`.
- Mailboxes and SPF/DKIM for the domain: use `domain-email`.
- Payments: a payment provider's own checkout, never a form that collects card numbers.

## Done when

- One form sends to the address the user named, by the way chosen in step 1, with no secret in any file the browser loads.
- Labels, required fields, errors, a honeypot and a privacy sentence are in place.
- A real test message arrived (the user confirmed it), and the empty-field and wrong-email tries were refused.
- You told the user in one sentence where messages go and what the service or host may limit.
