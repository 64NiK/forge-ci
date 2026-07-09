# forge-ci

A self-hosted CI server I built from scratch. You define a pipeline in YAML, and forge clones your repo, runs each step inside a fresh Docker container, and streams the logs live to the dashboard while the build is running.

## How it works

A build starts when you trigger it from the dashboard, send a POST request, or push to GitHub. forge puts it in a queue, does a shallow clone of the repo, and reads the `.forge.yml` file from the root. Each step in the pipeline gets its own fresh Docker container with the workspace mounted. Stdout and stderr stream to the browser in real time over SSE. When the build finishes, the result gets saved to SQLite along with per-step timings and exit codes.

## Pipeline file

Drop a `.forge.yml` in the root of your repo:

```yaml
image: node:20
steps:
  - name: install
    run: npm ci
  - name: typecheck
    run: npx tsc --noEmit
  - name: build
    run: npm run build
```

Steps run in order, each in a fresh container. They all share the same workspace volume so files carry over between steps. A non-zero exit code fails the build and skips the rest.

## Running it

You need Node 20+ and Docker running.

```bash
npm install
npm run dev
```

Dashboard runs on `http://localhost:4400`. You can trigger builds from there, with curl, or by pointing a GitHub webhook at it.

```bash
curl -X POST localhost:4400/api/builds \
  -H "Content-Type: application/json" \
  -d '{"repoUrl": "https://github.com/you/repo", "branch": "main"}'
```

## Features

- YAML pipelines with a configurable Docker image and ordered steps
- Each step runs in its own container, a shared npm cache volume keeps installs fast
- Logs stream live to the browser over SSE, late joiners get a full replay
- One build runs at a time, cancelling a build kills the container directly so no orphaned processes
- Builds, steps, timings, and exit codes are saved in SQLite
- Status badges served at `GET /badge/<repo>.svg`
- GitHub push webhooks supported

## Stack

Node.js, TypeScript, Express, better-sqlite3. The dashboard is plain HTML, CSS, and vanilla JS with no framework or build step. Docker is driven through the CLI.
