import { EventEmitter } from "node:events";

// One bus for the whole server; SSE handlers subscribe per build.
// Event names: `build:${id}` with payloads describing what changed.
export type BuildEvent =
  | { type: "log"; step: number; chunk: string }
  | { type: "step"; step: number; status: string; exitCode?: number | null }
  | { type: "build"; status: string }
  | { type: "meta"; commitSha: string; commitMsg: string };

class Bus extends EventEmitter {}
export const bus = new Bus();
bus.setMaxListeners(100);

export const emit = (buildId: number, event: BuildEvent) => bus.emit(`build:${buildId}`, event);
