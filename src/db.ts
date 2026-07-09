import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = path.join(process.cwd(), ".forge");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "forge.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS builds (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_url    TEXT NOT NULL,
    repo_name   TEXT NOT NULL,
    branch      TEXT NOT NULL DEFAULT 'main',
    commit_sha  TEXT,
    commit_msg  TEXT,
    trigger     TEXT NOT NULL DEFAULT 'manual',
    status      TEXT NOT NULL DEFAULT 'queued',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    started_at  TEXT,
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS steps (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    build_id    INTEGER NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
    idx         INTEGER NOT NULL,
    name        TEXT NOT NULL,
    cmd         TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    exit_code   INTEGER,
    started_at  TEXT,
    finished_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_builds_repo ON builds(repo_name, id DESC);
  CREATE INDEX IF NOT EXISTS idx_steps_build ON steps(build_id, idx);
`);

export type BuildStatus = "queued" | "running" | "passed" | "failed" | "canceled" | "error";
export type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "canceled";

export interface BuildRow {
  id: number;
  repo_url: string;
  repo_name: string;
  branch: string;
  commit_sha: string | null;
  commit_msg: string | null;
  trigger: string;
  status: BuildStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface StepRow {
  id: number;
  build_id: number;
  idx: number;
  name: string;
  cmd: string;
  status: StepStatus;
  exit_code: number | null;
  started_at: string | null;
  finished_at: string | null;
}

export const logDir = (buildId: number) => path.join(DATA_DIR, "logs", String(buildId));
export const workspaceDir = (buildId: number) => path.join(DATA_DIR, "workspaces", String(buildId));
