# Security

SiberSentez runs on your own computer, serves its panel on `127.0.0.1` only, and starts AI tools and terminals in your
project folders when you press a button. A mistake there matters, so reports are welcome.

## Reporting a problem

Please report a vulnerability **privately**: on this repository's **Security** tab, choose **Report a vulnerability**
(GitHub private vulnerability reporting), or write to **guvenlik@sibersentez.com**. Do not open a public issue for it.

Useful to include: the version (the first line of Settings → Help → Diagnostic info, or the installer's name), what you did, what happened, and what
should have happened. A proof of concept is welcome; please do not run it against other people's computers.

You will get an answer within a week. When a fix is ready, the release notes name the problem (and you, if you wish).

## What counts

- A web page in your browser, another program, or a file in a project that makes SiberSentez run a command, open a
  terminal, install or delete files, change the actions mode, or read files it should not, without your click.
- A way around the actions mode (Off / Preview / On), the confirmation for On, or the folder rules (broad folders,
  links, the hub, the program folder).
- A path, a user name, an API key or a token reaching the page, a log or a file where it should not.
- The local server answering anything other than `127.0.0.1`, a request from another origin, or an `/api` request
  without the per-launch session key (another program, or another Windows account on the same computer).

Out of scope: the AI tools themselves (Claude Code, Codex CLI, ...), what an AI tool does inside the terminal you
started, and problems that need someone who already controls your Windows account (see *Privacy and security* in the
README: the actions confirmation guards against accidents, it is not a security boundary).

The design and its limits: [README → Privacy and security](README.md#privacy-and-security),
[docs/actions-toggle.md](docs/actions-toggle.md).
