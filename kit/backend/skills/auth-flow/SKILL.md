---
name: auth-flow
description: "Adds sign-up, sign-in, sessions, password reset and access control to a project: first decides between a ready-made sign-in service and building it, then stores passwords safely, protects every route and record, and proves it with tests. Use when users need accounts, a login, or only some people may see or change something."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.2"
  sibersentez-checked: "2026-10-01"
  sibersentez-tags: "backend, security, database"
  sibersentez-stage: "build"
  sibersentez-keywords-tr: "kayıt ol*, giriş yap*, üye ol*, üyelik*, oturum aç*, şifre sıfırla*, parola sıfırla*, kullanıcı girişi, login, kimlik doğrula*, yetkilendirme"
---

# Auth flow

Goal: people can create an account, sign in and out, reset a forgotten password, and each person reaches only what
is theirs. Mistakes here expose other people's data, so go slowly and prove each part. The flows in order, the
cookie settings and the test list are in [reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- Passwords, tokens and session ids never go into code, logs, chat or test output. Tests use made-up accounts.

## 1. Is an account really needed?

Ask: "Who must be told apart, and what may each person do that others may not?" If the answer is "only me", a
single secret in `.env` or no sign-in at all may be enough. Write the answer down as rules: "a user sees only
their own notes; an admin sees all".

## 2. Ready-made service or your own?

| | A ready-made sign-in service | Building it yourself |
|---|---|---|
| Effort and risk | small; experts maintain the hard parts | large; every detail is yours to get right |
| Cost and control | may cost money at scale; data lives with the provider | free; full control |
| Fits | public sites, real customers, anything sensitive | learning, a private tool, a school project |

Recommend the ready-made service for anything public or sensitive, name two options, and read their official
documentation for the current setup steps (do not rely on memory). If the user builds their own, continue below.
Sign in with an outside account (Google and others) is a ready-made service too.

## 3. Own accounts: the data

Use `database-schema` for the table. `users`: `id`, `email` (unique, saved in lower case), `password_hash`,
`created_at`. Never a `password` column. If the project needs roles, add a `role` column with a short fixed list
and default to the least powerful one.

## 4. Passwords

- Hash with a slow, salted method from a maintained library (Argon2id first; scrypt if it is not available; bcrypt only for old systems, and it reads at most 72 bytes of the password). Never invent one, never
  use a plain fast hash, never encrypt passwords so they can be read back.
- Ask before installing the library. Say why a slow hash matters: a stolen table cannot be cracked quickly.
- Accept long passwords (at least 10 characters, allow spaces), refuse the very common ones if a list is at hand.
  No "must contain a symbol" rules; length matters more.

## 5. Sign-up, sign-in, sign-out

Follow the flows in the reference. Four rules: wrong email and wrong password get the same message; sign-in is
rate limited per account and per address; the session id is random, kept on the server and sent in a cookie that is
`HttpOnly`, `Secure` and `SameSite`; sign-out deletes the server side session, not only the cookie.

## 6. Password reset

A random single-use token, only its hash stored, valid for 30 to 60 minutes, sent to the email on file. The page
answers the same way whether or not the email exists. A reset ends all other sessions of that person. Sending email
needs a provider: ask which and keep its key in `.env` (`env-and-secrets`).

## 7. Access control

- Every route that is not public checks the session on the server. Hiding a button is not protection.
- Every read, change and delete of a record checks that it belongs to the signed-in person, or that their role
  allows it. Refuse by default: allow only what a rule names.
- Try it: sign in as person A, ask for person B's record by its id. It must be refused.

## 8. Prove it

Write the tests from the reference list and run them (`test-first`). Then try the flow by hand the way a user does.
For a final look at the whole project, use `security-check`.

## Do not use for

- Where API keys live: use `env-and-secrets`.
- A key or password that leaked: use `secrets-cleanup`.
- The tables themselves: use `database-schema`.

## Done when

- The user chose a ready-made service or their own, and the rules ("who may do what") are written down.
- Passwords are stored only as slow hashes; a look at the table (fake accounts) shows no readable password.
- The tests pass (show the summary): wrong password refused, protected route refused without a session,
  person A refused person B's record, sign-out ends the session, a used or expired reset token refused.
- The cookie flags and the rate limit were checked on the running program, and you said what remains open.
