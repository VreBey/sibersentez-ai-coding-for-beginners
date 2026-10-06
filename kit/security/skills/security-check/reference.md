# Security check: reference

Details for the `security-check` skill. Read only the part you need.

## Search terms for secrets

Search case-insensitively in tracked files (`git grep -n -i "<term>"`) and in the history when needed.

| Looks like | Often is |
|---|---|
| `sk-`, `sk_live_`, `pk_live_` followed by long random text | AI or payment provider keys |
| `ghp_`, `gho_`, `github_pat_` | GitHub tokens |
| `AKIA` followed by 16 capitals and digits | cloud access keys |
| `AIza` followed by long text | Google API keys |
| `xoxb-`, `xoxp-` | Slack tokens |
| digits, a colon, then about 35 letters and digits | Telegram bot tokens |
| `-----BEGIN` ... `PRIVATE KEY-----` | private keys |
| `password=`, `passwd`, `secret=`, `token=`, `api_key`, `apikey` | hard-coded credentials |
| `mongodb://user:pass@`, `postgres://user:pass@` | database URLs with passwords |

Also check: `.env` files that are tracked (`git ls-files "*.env*"`), config files with
`Password` fields, notebooks with printed outputs, log files, screenshots in the repository.

## If a secret leaked

1. Revoke it at the provider and create a new one. Only the user can do this; give them the exact page to visit.
2. Put the new secret in `.env` (not tracked) and read it from the environment in code.
3. Remove it from the current files and commit.
4. Only then discuss cleaning the history. Rewriting history changes every later commit and affects everyone who
   cloned the project: explain, and ask before doing anything.

## Checklist by kind of project

**Web app or API**
- Server-side validation on every route; a schema library is fine.
- Parameterized queries or an ORM; no string-built SQL.
- Sessions or tokens expire; logout clears them; passwords stored with a slow hash (bcrypt, scrypt, Argon2).
- Security headers set (Content-Security-Policy, X-Content-Type-Options); no secrets in public environment variables
  (anything a framework exposes to the browser is public).

**Chat bot**
- Token only in the environment. Restart after changing it.
- Admin commands check the user id against an allow list.
- Rate limit per user; ignore messages from other bots.
- Never run shell commands or open files based on message text.

**Desktop app (Electron)**
- Context isolation on, Node integration off, sandbox on: never turn them off.
- The preload bridge exposes a few named functions, never a general "run this" or "read any file" function.
- The main process validates every argument coming from the page.
- Remote websites never get the bridge; links open in the user's browser.
- User data is written under the app's data folder, never into the install folder.

**Mobile app**
- No secret keys in the app bundle; call your own server instead.
- Store tokens in secure storage, not plain storage.
- Ask only for the phone permissions the app really uses.

**Game**
- Never trust the client in multiplayer: the server checks moves, scores and purchases.
- Save files can be edited by players; check them when loading.

**Scripts and automation**
- Credentials in the environment or the system's credential store, not in the script.
- Scheduled tasks run with the least rights they need.
- Scrapers respect the site's terms, go slowly, and prefer an official API.

## Dependency vulnerability scan

Dependencies are other people's code. A scan compares the exact versions in the lock file with a public list of known
weaknesses. It needs the network, and it reads: it never changes the project.

| Ecosystem | Scan | Notes |
|---|---|---|
| npm | `npm audit` (add `--omit=dev` to look at what ships to users) | the tool is part of npm; the lock file must exist |
| Python | `pip-audit -r requirements.txt` | `pip-audit` is a separate tool: install it into the project's own environment, after a yes |
| .NET | `dotnet list package --vulnerable --include-transitive` | part of the .NET command line tool |
| Rust | `cargo audit` | a separate tool: install it first, after a yes |
| Anything else | read the language's own documentation for its audit tool | do not invent a command |

How to read the result, in plain words:

- **Severity** (low, moderate, high, critical) says how bad the weakness is **if it can be used** in your project.
- **Direct or indirect**: a direct dependency is in your manifest; an indirect one came with another package. For an
  indirect one the fix is usually to update the direct package that brings it.
- **Fix available**: the report names a safe version. Update that one package, run the tests, and commit
  (`dependency-update` does this step by step).
- **No fix yet**: say so; note whether your code even uses the weak part, and decide with the user: a different package,
  a workaround, or watching for a release.
- A "dev dependency" weakness (a test tool) matters far less than one that ships to users, but is not zero.

Never run the "fix everything automatically" variant of an audit command: it can jump major versions and break the
project without telling you. Never ignore the scan because it is noisy: sort by severity and look at critical and high
first. Report the numbers before and after, and when the scan could not run (no network, no tool), write "not scanned"
in the report instead of "no problems".
