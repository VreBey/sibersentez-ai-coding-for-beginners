---
name: docker-basics
description: "Puts a project in a container: a first Dockerfile and a compose file with every line explained, a .dockerignore, secrets passed at run time and never baked in, then builds it, runs it and proves the app answers. Use when the user wants the app to run the same everywhere, asks about Docker or containers, or a host needs a container image."
license: "MIT (see LICENSE.md)"
metadata:
  author: "SiberSentez"
  version: "0.1.0"
  sibersentez-tags: "devops"
  sibersentez-stage: "ship"
  sibersentez-keywords-tr: "docker*, dockerfile, konteyner*, compose, container, docker compose, imaj*, her yerde aynı çalışsın"
---

# Docker basics

A container is the program plus everything it needs, packed so it runs the same on any computer that has Docker.
The recipe is a `Dockerfile`; a `compose.yaml` file says how to start it with its settings. Full examples for the two
common cases and the error table are in [reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- Never put a secret into the image: no `.env` copied in, no key in the Dockerfile. Values are given when it runs.
- Commands that remove images, containers, volumes or caches always need a yes, after showing what they remove.
  Removing a volume deletes the data stored in it.

## 1. Check Docker

`docker --version`, then `docker info`. "Cannot connect to the Docker daemon" means Docker Desktop is not running:
start it and wait. If Docker is not installed, the user installs Docker Desktop from docker.com (it needs
virtualization turned on, and on Windows a Linux layer called WSL 2, which its installer sets up); it is a system
change, so ask first. Open a new terminal afterwards.

## 2. Learn how the app starts

Find out and write down: the command that starts it, the port it listens on, the settings it reads (names only),
and the folder where it keeps data (if any). Run it once without Docker to be sure it works (`verify-before-done`).

## 3. Write the Dockerfile

Use the example for the project's kind from the reference. Put a short comment above every instruction and read the
file to the user line by line. The shape never changes:

| Part | Why |
|---|---|
| `FROM <image>:<version>` | the starting layer; pin a version, never `latest`, so a build today matches one next month |
| `WORKDIR /app` | the folder inside the container where everything happens |
| copy the dependency list, then install | this layer is cached: rebuilds are fast when only your code changed |
| copy the rest of the code | after the install, for the same reason |
| a non-root user | a bug in the app cannot do as much damage |
| `EXPOSE` and `CMD` | the port it uses (a note) and the command that starts it |

## 4. `.dockerignore`

A file listing what must never be copied into the image: `.git`, `.env` and `.env.*`, the dependency folder
(rebuilt inside), logs, the local data folder, build output, editor folders. Without it, secrets and gigabytes get
packed. Explain each line.

## 5. `compose.yaml`

One service with the build instruction, the port mapping (`"3000:3000"`), `env_file: .env` (read at run time, not
copied), a named volume or a folder for data that must survive, and a restart policy. Explain: the left port is on this
computer, the right one inside the container.

## 6. Build, run, prove

1. `docker build -t myapp .` (it downloads layers: the user says yes first).
2. `docker compose up --build`, in the user's terminal if your tool cannot keep it running.
3. From a second terminal: `curl.exe http://localhost:3000/health` (or open the address). Show the answer.
4. `docker compose logs` shows what the app printed. Stop with Ctrl+C, then `docker compose down` (this keeps volumes).
5. Check the app inside the container reads its settings and keeps its data after a restart.

## 7. Tidy and explain

Show `docker system df` so the user sees the space images use, and explain how to remove an image they no longer
need (after a yes). Add three lines to the README: build, run, stop. Never push the image anywhere without a yes;
for hosting, go on with `deploy-web`.

## Do not use for

- Putting a site on a host without a container: use `deploy-web`.
- Keeping settings and keys out of code in general: use `env-and-secrets`.
- Automatic builds on every push: use `github-actions-setup`.

## Done when

- `Dockerfile`, `.dockerignore` and `compose.yaml` exist, each line explained to the user, and no secret is in them.
- `docker compose up --build` ran, and a request to the app was answered (show the command and the output).
- The settings reached the container from `.env` at run time, and data survived a restart if the app keeps data.
- You told the user in one sentence how to start and stop it again.
