# Secrets cleanup: reference

Checked 2026-09-30 (revisit every six months). Provider pages and settings move around: check the official pages.

- GitHub, removing sensitive data from a repository:
  https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository
- GitHub secret scanning and push protection (what it is, how to switch it on for a repository):
  https://docs.github.com/en/code-security/secret-scanning
- The history-rewriting tool that GitHub's guide recommends is a separate program (git-filter-repo,
  https://github.com/newren/git-filter-repo). Installing it needs the user's yes. Follow its documentation for the
  exact command; do not write it from memory.

## What to revoke, by kind of secret

| Kind | What to do (each provider has its own page: check its documentation) |
|---|---|
| API key of a service (AI, maps, mail, payments) | delete the key in the provider's dashboard, create a new one; check usage for calls you did not make |
| Payment provider key | a live secret key: revoke at once and check recent payments; test-mode keys are less urgent |
| Database password or connection URL | change the password in the database service, update the app; check for logins you do not know |
| Cloud access keys | disable the key, create a new one, review recent activity |
| Bot token (chat services) | the bot's owner tool has a command or a page to create a new token; the old one stops working |
| Personal access token (git hosts) | delete it under the account's token settings, create a new one with the fewest rights |
| A password used by a person | change it everywhere it was used, turn on two-step sign-in |
| A private key file (SSH, certificates) | remove it from the service that trusts it, create a new pair |

## Looking for the secret in git

| Question | Command |
|---|---|
| Which commits added or removed this text? | `git log --all --oneline -S"first-characters"` |
| Is there an online copy? | `git remote -v` and `git status -sb` |
| Was `.env` ever committed? | `git log --all --oneline -- .env` |
| Is `.env` ignored now? | `git check-ignore -v .env` (prints the rule if yes, nothing if no) |
| Which tracked files look risky? | `git ls-files` and read the names (`.env`, `*.pem`, `credentials`) |

Use only the first four characters of a secret in these commands, so the full secret never appears in your output
or in the shell history.

## Backup before any history rewrite

The simplest backup is a copy of the whole project folder (including its hidden `.git` folder) to another place.
Open the copy and run `git log --oneline -3` in it to see that it is complete. Keep it until the user says the
result is fine.

## After a rewrite: what the user must know

- Everyone with a copy must clone again; their old copies contain the secret.
- Forks and pull requests on the hosting service may keep the old commits for a while: the hosting service's guide
  and support explain how to ask for cached data to be removed.
- The secret is still considered leaked. The revoke in step 2 is what protects the user.
