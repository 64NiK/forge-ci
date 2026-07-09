import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { db, logDir, workspaceDir, BuildRow, StepRow } from "./db.js";
import { emit } from "./events.js";

const DEFAULT_IMAGE = "node:20";
const STEP_TIMEOUT_MS = 15 * 60 * 1000;

interface Pipeline {
  image?: string;
  steps: { name: string; run: string }[];
}

/** Tracks the live process of the currently running build so cancel can reach it. */
const active = new Map<number, { proc: ChildProcess | null; canceled: boolean; containers: string[] }>();

// ---- Queue: one build at a time, like a single shared runner ----
const queue: number[] = [];
let running = false;

export function enqueue(buildId: number) {
  queue.push(buildId);
  void drain();
}

async function drain() {
  if (running) return;
  const next = queue.shift();
  if (next === undefined) return;
  running = true;
  try {
    await runBuild(next);
  } finally {
    running = false;
    void drain();
  }
}

export function cancel(buildId: number): boolean {
  // Still queued: drop it before it starts
  const qi = queue.indexOf(buildId);
  if (qi !== -1) {
    queue.splice(qi, 1);
    finishBuild(buildId, "canceled");
    return true;
  }
  const live = active.get(buildId);
  if (!live) return false;
  live.canceled = true;
  live.proc?.kill("SIGTERM");
  // Containers get a name per step so we can reach them from outside
  for (const name of live.containers) {
    spawn("docker", ["rm", "-f", name], { stdio: "ignore" });
  }
  return true;
}

function setBuild(buildId: number, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE builds SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), buildId);
}

function finishBuild(buildId: number, status: string) {
  setBuild(buildId, { status, finished_at: new Date().toISOString() });
  emit(buildId, { type: "build", status });
}

function appendLog(buildId: number, stepIdx: number, chunk: string) {
  fs.appendFileSync(path.join(logDir(buildId), `${stepIdx}.log`), chunk);
  emit(buildId, { type: "log", step: stepIdx, chunk });
}

/** Run a command, streaming output into the step log. Resolves with the exit code. */
function run(
  buildId: number,
  stepIdx: number,
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {}
): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd: opts.cwd, env: process.env });
    const live = active.get(buildId);
    if (live) live.proc = proc;

    const timeout = setTimeout(() => {
      appendLog(buildId, stepIdx, `\n[forge] step timed out after ${STEP_TIMEOUT_MS / 60000} minutes\n`);
      proc.kill("SIGKILL");
    }, STEP_TIMEOUT_MS);

    proc.stdout.on("data", (d) => appendLog(buildId, stepIdx, d.toString()));
    proc.stderr.on("data", (d) => appendLog(buildId, stepIdx, d.toString()));
    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (live) live.proc = null;
      resolve(code ?? 1);
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      appendLog(buildId, stepIdx, `[forge] failed to start: ${err.message}\n`);
      if (live) live.proc = null;
      resolve(127);
    });
  });
}

function setStep(stepId: number, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE steps SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), stepId);
}

async function runBuild(buildId: number) {
  const build = db.prepare("SELECT * FROM builds WHERE id = ?").get(buildId) as BuildRow | undefined;
  if (!build || build.status === "canceled") return;

  active.set(buildId, { proc: null, canceled: false, containers: [] });
  fs.mkdirSync(logDir(buildId), { recursive: true });
  const ws = workspaceDir(buildId);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });

  setBuild(buildId, { status: "running", started_at: new Date().toISOString() });
  emit(buildId, { type: "build", status: "running" });

  const fail = (msg: string, status = "error") => {
    appendLog(buildId, 0, `[forge] ${msg}\n`);
    finishBuild(buildId, status);
    active.delete(buildId);
  };

  try {
    // ---- Step 0 is always the clone, so its output is visible like any other step ----
    const cloneStep = db
      .prepare("INSERT INTO steps (build_id, idx, name, cmd, status, started_at) VALUES (?, 0, 'clone', ?, 'running', ?)")
      .run(buildId, `git clone --depth 1 -b ${build.branch} ${build.repo_url}`, new Date().toISOString());
    emit(buildId, { type: "step", step: 0, status: "running" });

    const cloneCode = await run(buildId, 0, "git", [
      "clone", "--depth", "1", "--branch", build.branch, build.repo_url, ws,
    ]);
    const live = active.get(buildId);
    if (live?.canceled) return fail("build canceled", "canceled");
    setStep(Number(cloneStep.lastInsertRowid), {
      status: cloneCode === 0 ? "passed" : "failed",
      exit_code: cloneCode,
      finished_at: new Date().toISOString(),
    });
    emit(buildId, { type: "step", step: 0, status: cloneCode === 0 ? "passed" : "failed", exitCode: cloneCode });
    if (cloneCode !== 0) return fail("clone failed", "failed");

    // Record what we actually checked out
    const sha = spawnSyncCapture("git", ["rev-parse", "--short", "HEAD"], ws);
    const msg = spawnSyncCapture("git", ["log", "-1", "--pretty=%s"], ws);
    setBuild(buildId, { commit_sha: sha, commit_msg: msg });
    emit(buildId, { type: "meta", commitSha: sha, commitMsg: msg });

    // ---- Parse pipeline ----
    const configPath = [".forge.yml", "forge.yml"].map((f) => path.join(ws, f)).find(fs.existsSync);
    if (!configPath) return fail("no .forge.yml found in repository", "error");

    let pipeline: Pipeline;
    try {
      pipeline = YAML.parse(fs.readFileSync(configPath, "utf8"));
      if (!Array.isArray(pipeline.steps) || pipeline.steps.length === 0) throw new Error("no steps");
      for (const s of pipeline.steps) {
        if (!s.name || !s.run) throw new Error("each step needs a name and a run command");
      }
    } catch (e) {
      return fail(`invalid .forge.yml: ${(e as Error).message}`, "error");
    }

    const image = pipeline.image ?? DEFAULT_IMAGE;

    // ---- Execute steps sequentially in Docker ----
    let failed = false;
    for (let i = 0; i < pipeline.steps.length; i++) {
      const step = pipeline.steps[i];
      const idx = i + 1; // 0 is clone
      const stepRow = db
        .prepare("INSERT INTO steps (build_id, idx, name, cmd, status) VALUES (?, ?, ?, ?, 'pending')")
        .run(buildId, idx, step.name, step.run);
      const stepId = Number(stepRow.lastInsertRowid);

      if (failed || active.get(buildId)?.canceled) {
        setStep(stepId, { status: "skipped" });
        emit(buildId, { type: "step", step: idx, status: "skipped" });
        continue;
      }

      setStep(stepId, { status: "running", started_at: new Date().toISOString() });
      emit(buildId, { type: "step", step: idx, status: "running" });
      appendLog(buildId, idx, `$ ${step.run}\n`);

      const containerName = `forge-${buildId}-${idx}`;
      active.get(buildId)?.containers.push(containerName);

      // Each step runs in a fresh container; the workspace and npm cache are shared volumes
      const code = await run(buildId, idx, "docker", [
        "run", "--rm",
        "--name", containerName,
        "-v", `${ws}:/work`,
        "-v", "forge-npm-cache:/root/.npm",
        "-w", "/work",
        "--network", "bridge",
        image,
        "sh", "-c", step.run,
      ]);

      if (active.get(buildId)?.canceled) {
        setStep(stepId, { status: "canceled", exit_code: code, finished_at: new Date().toISOString() });
        emit(buildId, { type: "step", step: idx, status: "canceled" });
        return fail("build canceled", "canceled");
      }

      setStep(stepId, {
        status: code === 0 ? "passed" : "failed",
        exit_code: code,
        finished_at: new Date().toISOString(),
      });
      emit(buildId, { type: "step", step: idx, status: code === 0 ? "passed" : "failed", exitCode: code });
      if (code !== 0) failed = true;
    }

    finishBuild(buildId, failed ? "failed" : "passed");
  } catch (e) {
    fail(`internal error: ${(e as Error).message}`);
  } finally {
    active.delete(buildId);
    // Keep workspaces from piling up
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

function spawnSyncCapture(cmd: string, args: string[], cwd: string): string {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export function getSteps(buildId: number): StepRow[] {
  return db.prepare("SELECT * FROM steps WHERE build_id = ? ORDER BY idx").all(buildId) as StepRow[];
}

export function readLog(buildId: number, stepIdx: number): string {
  const p = path.join(logDir(buildId), `${stepIdx}.log`);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}
