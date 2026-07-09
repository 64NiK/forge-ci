import express from "express";
import path from "node:path";
import { db, BuildRow } from "./db.js";
import { enqueue, cancel, getSteps, readLog } from "./runner.js";
import { bus, BuildEvent } from "./events.js";
import { badge } from "./badge.js";

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

const PORT = Number(process.env.PORT ?? 4400);

function repoNameFrom(url: string): string {
  const clean = url.replace(/\/+$/, "").replace(/\.git$/, "");
  return clean.split("/").pop() ?? clean;
}

function createBuild(repoUrl: string, branch: string, trigger: string): BuildRow {
  const res = db
    .prepare("INSERT INTO builds (repo_url, repo_name, branch, trigger) VALUES (?, ?, ?, ?)")
    .run(repoUrl, repoNameFrom(repoUrl), branch, trigger);
  const build = db.prepare("SELECT * FROM builds WHERE id = ?").get(res.lastInsertRowid) as BuildRow;
  enqueue(build.id);
  return build;
}

// ---- API ----

app.get("/api/builds", (req, res) => {
  const repo = req.query.repo as string | undefined;
  const builds = repo
    ? db.prepare("SELECT * FROM builds WHERE repo_name = ? ORDER BY id DESC LIMIT 50").all(repo)
    : db.prepare("SELECT * FROM builds ORDER BY id DESC LIMIT 50").all();
  res.json(builds);
});

app.post("/api/builds", (req, res) => {
  const { repoUrl, branch } = req.body ?? {};
  if (!repoUrl) return res.status(400).json({ error: "repoUrl is required" });
  const build = createBuild(String(repoUrl), String(branch || "main"), "manual");
  res.status(201).json(build);
});

app.get("/api/builds/:id", (req, res) => {
  const build = db.prepare("SELECT * FROM builds WHERE id = ?").get(req.params.id) as BuildRow | undefined;
  if (!build) return res.status(404).json({ error: "not found" });
  res.json({ ...build, steps: getSteps(build.id) });
});

app.get("/api/builds/:id/logs/:step", (req, res) => {
  res.type("text/plain").send(readLog(Number(req.params.id), Number(req.params.step)));
});

app.post("/api/builds/:id/cancel", (req, res) => {
  const ok = cancel(Number(req.params.id));
  res.json({ canceled: ok });
});

app.post("/api/builds/:id/retry", (req, res) => {
  const build = db.prepare("SELECT * FROM builds WHERE id = ?").get(req.params.id) as BuildRow | undefined;
  if (!build) return res.status(404).json({ error: "not found" });
  res.status(201).json(createBuild(build.repo_url, build.branch, "retry"));
});

// ---- Live updates: SSE stream per build ----
app.get("/api/builds/:id/events", (req, res) => {
  const buildId = Number(req.params.id);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  // Replay current state so late joiners see full logs, then follow live
  const build = db.prepare("SELECT * FROM builds WHERE id = ?").get(buildId) as BuildRow | undefined;
  if (build) {
    const steps = getSteps(buildId);
    res.write(`data: ${JSON.stringify({ type: "snapshot", build, steps, logs: steps.map((s) => readLog(buildId, s.idx)) })}\n\n`);
  }

  const onEvent = (event: BuildEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  bus.on(`build:${buildId}`, onEvent);
  const keepalive = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    bus.off(`build:${buildId}`, onEvent);
    clearInterval(keepalive);
  });
});

// ---- GitHub-style webhook: push event triggers a build ----
app.post("/webhook/github", (req, res) => {
  const repoUrl = req.body?.repository?.clone_url;
  if (!repoUrl) return res.status(400).json({ error: "unrecognized payload" });
  const branch = String(req.body?.ref ?? "refs/heads/main").replace("refs/heads/", "");
  const build = createBuild(repoUrl, branch, "webhook");
  res.status(201).json({ build: build.id });
});

// ---- Status badge ----
app.get("/badge/:repo.svg", (req, res) => {
  const last = db
    .prepare("SELECT status FROM builds WHERE repo_name = ? AND status NOT IN ('queued','running') ORDER BY id DESC LIMIT 1")
    .get(req.params.repo) as { status: string } | undefined;
  res.type("image/svg+xml").set("Cache-Control", "no-cache").send(badge(last?.status ?? "unknown"));
});

app.get("/build/:id", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "build.html"));
});

app.listen(PORT, () => {
  console.log(`forge-ci listening on http://localhost:${PORT}`);
});
