# Docker basics: reference

Checked 2026-10-01 (revisit every six months). Official pages: https://docs.docker.com/get-started/ ,
https://docs.docker.com/reference/dockerfile/ and https://docs.docker.com/compose/ . Image names and versions
change: look up the current long-term-support tag of the runtime image on its official page and use that, not the
numbers written here. These files were written from the documentation; read what the build prints.

## Example A: a Node.js app that listens on port 3000

`Dockerfile`:

```dockerfile
# Starting layer: a small Node.js image with a pinned version (check the current LTS tag)
FROM node:22-alpine

# Everything below happens in /app inside the container
WORKDIR /app

# Copy only the dependency lists first, so this slow step is cached
COPY package.json package-lock.json ./

# Install exactly what the lock file says, production packages only
RUN npm ci --omit=dev

# Now the code (what .dockerignore does not exclude)
COPY . .

# Run as the unprivileged user the image already contains
USER node

# A note for readers: the app listens on 3000
EXPOSE 3000

# The command that starts the app
CMD ["node", "server.js"]
```

## Example B: a Python app that listens on port 8000

```dockerfile
# Starting layer: a small Python image with a pinned version (check the current tag)
FROM python:3.12-slim

WORKDIR /app

# Do not write .pyc files and print output at once
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

# Dependencies first (cached), then the code
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# An unprivileged user
RUN useradd --create-home appuser
USER appuser

EXPOSE 8000

# 0.0.0.0 so the app can be reached from outside the container
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Change the last line to whatever starts the project (`python app.py`, and so on). A web server inside a container
must listen on `0.0.0.0`, not `127.0.0.1`, or nothing outside can reach it.

## .dockerignore

```
.git
.gitignore
.env
.env.*
node_modules
.venv
__pycache__
*.log
data/
backups/
dist/
.vscode/
.idea/
Dockerfile
compose.yaml
```

`.env.example` may stay if you remove the `.env.*` line, or list it as `!.env.example`.

## compose.yaml

```yaml
services:
  app:
    build: .
    ports:
      - "3000:3000"        # this computer : inside the container
    env_file:
      - .env               # read when it starts, never copied into the image
    volumes:
      - app-data:/app/data # data that must survive a restart
    restart: unless-stopped

volumes:
  app-data:
```

Compose files are YAML: indentation with spaces, never tabs. `docker compose config` prints the file as Docker reads it
and shows mistakes.

## The commands

| Goal | Command |
|---|---|
| Build the image | `docker build -t myapp .` |
| Run once and remove the container after | `docker run --rm -p 3000:3000 --env-file .env myapp` |
| Start with compose, rebuilding | `docker compose up --build` |
| Start in the background | `docker compose up -d --build` |
| See what runs | `docker ps` |
| Read the app's output | `docker compose logs` |
| Stop and remove the containers (volumes stay) | `docker compose down` |
| Space used | `docker system df` |
| Open a shell in the running container | `docker compose exec app sh` |

Removing images, containers or volumes by hand is a separate step: show the user the list, name what is lost, ask.

## Common problems

| Message or symptom | Cause and fix |
|---|---|
| `Cannot connect to the Docker daemon` or `error during connect` | Docker Desktop is not running. Start it, wait until it says it is running. |
| `port is already allocated` | another program or container uses that port. Change the left number in `ports`, or stop the other one. |
| The page does not open though the container runs | the app listens on `127.0.0.1` inside; make it listen on `0.0.0.0`. Check the port numbers match. |
| `COPY failed: file not found` | the path is outside the build folder, or `.dockerignore` excludes it. Paths are relative to the folder given to `docker build`. |
| The app says a setting is missing | `.env` is not read: check `env_file`, and that `.env` exists next to `compose.yaml`; do not copy it into the image. |
| `exec format error` or `^M` in a script | the script has Windows line endings. Save it with Unix line endings (LF). |
| `permission denied` writing data | the non-root user cannot write that folder: create it and set its owner in the Dockerfile, or use a named volume. |
| Every rebuild takes minutes | the code is copied before the dependency install, so the cache is lost. Copy the dependency lists first. |
| The image is huge | no `.dockerignore`, a heavy base image, or build tools left inside. Use a slim or alpine base and ignore folders. |
| Data is gone after `down` | it was inside the container, not in a volume. Mount a volume for the data folder. |
| Very slow on Windows | project files on a Windows drive are slow to share into Linux containers; keep dependencies inside the image. |
| Build works, app crashes at start | run it without Docker first, then read `docker compose logs`: the first red line names the cause. |

## Every line, explained

When you walk the user through the Dockerfile, use this shape for each instruction: the line, one sentence on what it
does, one sentence on what would go wrong without it. For example: `COPY package.json package-lock.json ./` copies only
the two dependency files. Without this separate step every code change would reinstall every package.
