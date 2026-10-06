# Auth flow: reference

Plain steps, not tied to a language. Use the project's own language and libraries, and ask before installing one.

## Sign-up

1. Take `email` and `password`. Trim and lower-case the email; check it looks like an email; check the password
   length (at least 10, allow spaces, allow very long ones up to a sensible limit such as 200; with bcrypt the limit is 72 bytes).
2. Look the email up. If it exists, do not say so on the page (that tells strangers who has an account); show
   "check your email" and send a note to that address instead. If that is too much for a first version, accept the
   leak and write it down as an open issue.
3. Hash the password with the library's function (it adds its own salt). Save `email` and `password_hash`.
4. Start a session (below) or send a confirmation email first, as the plan says.

## Sign-in

1. Look up the user by lower-cased email. If there is none, still run one hash check against a fixed dummy hash, so
   the answer takes as long as for a real user.
2. Verify the password with the library's verify function (never compare hashes yourself).
3. On failure answer with one message ("Email or password is wrong") and status 401. Count the failure.
4. Rate limit: after about 5 failures for one account or one address in a few minutes, refuse for a while.
5. On success create a new session (a new id every time: never reuse the id from before sign-in).

## Session

| Part | Rule |
|---|---|
| Id | at least 128 random bits from the system's secure random source, never a counter or a time |
| Stored | on the server (table `sessions`: id hash, user_id, created_at, expires_at); the cookie holds only the id |
| Cookie flags | `HttpOnly` (scripts cannot read it), `Secure` (HTTPS only; for local tests over http use a test setting), `SameSite=Lax` |
| Lifetime | a few days for ordinary sites, hours for sensitive ones; extend only on real use |
| Sign-out | delete the session row, clear the cookie |
| Sensitive actions | ask for the password again before changing the email, the password or deleting the account |

Pages that change data through a form or a request from the browser need a protection against forged requests:
`SameSite` helps, and a per-session token in forms (CSRF token) is the full answer. Use the framework's own.

## Password reset

1. Page "forgot password": take the email, answer "if this email exists we sent a link" every time.
2. If the user exists: make a random token (128 bits or more), store its **hash** with `user_id` and an expiry of
   30 to 60 minutes, email a link that carries the token. Never store or log the token itself.
3. The link opens a form for the new password. Check the token hash, the expiry and that it is unused; mark it used
   in the same step that changes the password.
4. Hash and save the new password, delete every session of that user, send "your password was changed" to the email.

## Access control patterns

- A check function used by every protected route: "is there a session, and who is it?" Missing: 401.
- A record check: load the record by id **and** by owner (`WHERE id = ? AND user_id = ?`). Not found or not yours:
  answer 404 (or 403 if the user may know it exists).
- Roles: a short list kept in the database; the check names the needed role, never "is the name admin".
- Admin pages and commands are checked like any route. First user as admin is a choice to make on purpose, written down.

## Tests to write

| Test | Expected |
|---|---|
| Sign up with a good email and password | account created, password column is not the plain text |
| Sign up with the same email twice | no second account |
| Sign-in with a wrong password | 401 and the same message as for an unknown email |
| Six wrong sign-ins in a row | refused for a while |
| A protected route without a session | 401 |
| Person A asks for person B's record | 404 or 403, and B's data is not in the answer |
| Sign out, then reuse the old cookie | 401 |
| Reset token used twice | the second use is refused |
| Reset token after its expiry | refused |
| The session cookie | has `HttpOnly` and `SameSite`; `Secure` outside local tests |

## Common problems

| Symptom | Cause and fix |
|---|---|
| Signed in, but the next request is anonymous | the cookie is `Secure` while testing over plain http, or the front end does not send cookies with its requests. |
| Works in the browser, fails from another site or port | cross-origin rules; allow only the exact origin and, with cookies, never a wildcard. |
| Everybody can read everybody's records | the record check is missing. Add the owner to every query. |
| "Invalid hash" after changing the library | the stored hashes use the old format; keep both verifiers until users have signed in again. |
| Reset emails never arrive | the provider key or sender address is not set up; test with the provider's test mode first. |
| Locked out of the admin account | keep a documented, offline way to reset it (a command run on the server); write it in the README without the password. |
