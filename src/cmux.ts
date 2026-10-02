// cmux backend for opencode-cmux-status.
//
// Replaces the tmux adapter from opencode-tmux-session-status (MIT, 4m1z)
// with cmux sidebar commands:
//   set-status / clear-status   -> status pill per project
//   set-progress / clear-progress -> workspace progress bar
//   log                         -> sidebar log line
//   notify                      -> desktop notification

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { State } from "./state";

export type Failure = "unavailable" | "timeout" | "other";
export type Result =
  { ok: true; output: string } | { ok: false; failure: Failure };

/** Spawn a command with output capture, timeout and abort support. */
export function run(
  command: string,
  args: string[],
  timeout: number,
  signal: AbortSignal,
  input?: string,
): Promise<Result> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve({ ok: false, failure: "other" });
    let output = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: Result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.stdout.on("data", (part: Buffer) => {
      output = (output + part.toString()).slice(0, 1024);
    });
    child.stderr.on("data", () => {});
    child.on("error", (err: NodeJS.ErrnoException) =>
      finish({
        ok: false,
        failure: err.code === "ENOENT" ? "unavailable" : "other",
      }),
    );
    child.on("close", (code) => {
      if (timedOut) return finish({ ok: false, failure: "timeout" });
      if (code === 0) return finish({ ok: true, output });
      finish({ ok: false, failure: "other" });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function clean(value: string, max: number): string {
  return value
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/ +/g, " ")
    .slice(0, max);
}

const COLORS: Record<State, string> = {
  working: "#ff9500",
  waiting: "#ffcc00",
  done: "#34c759",
  error: "#ff3b30",
  idle: "#8e8e93",
};

const LOG_LEVELS: Record<Exclude<State, "idle">, string> = {
  working: "progress",
  waiting: "warning",
  done: "success",
  error: "error",
};

export class CmuxAdapter {
  private readonly keys = new Map<string, string>();
  private readonly touched = new Set<string>();

  constructor(
    readonly bin: string,
    readonly workspace: string | undefined,
    readonly keyPrefix: string,
    readonly signal: AbortSignal,
    readonly diagnostic: (key: string, message: string) => void,
    readonly progress = true,
    readonly logs = true,
  ) {}

  private target(): string[] {
    return this.workspace ? ["--workspace", this.workspace] : [];
  }

  /** Stable cmux status key per project directory. */
  key(dir: string): string {
    const cached = this.keys.get(dir);
    if (cached) return cached;
    const hash = createHash("sha1").update(dir).digest("hex").slice(0, 8);
    const key = `${this.keyPrefix}${hash}`;
    this.keys.set(dir, key);
    return key;
  }

  /** Short human-readable project label. */
  label(dir: string): string {
    const base = dir.replace(/\/+$/, "").split("/").pop() || "opencode";
    return clean(base, 40) || "opencode";
  }

  async stamp(
    dir: string,
    state: State,
    since: number,
    detail: string,
    changedState: boolean,
  ): Promise<void> {
    if (this.signal.aborted) return;
    const label = this.label(dir);
    const key = this.key(dir);
    this.touched.add(key);

    const result = await run(
      this.bin,
      [
        "set-status",
        key,
        `${label}: ${state}`,
        "--color",
        COLORS[state],
        ...this.target(),
      ],
      2000,
      this.signal,
    );
    if (!result.ok && !this.signal.aborted)
      this.diagnostic(
        `cmux:${result.failure}`,
        `cmux set-status ${result.failure}`,
      );

    if (this.logs && changedState && state !== "idle") {
      await run(
        this.bin,
        [
          "log",
          "--level",
          LOG_LEVELS[state],
          "--source",
          "opencode",
          ...this.target(),
          "--",
          `${label}: ${clean(detail, 100) || state}`,
        ],
        2000,
        this.signal,
      );
    }

    if (!this.progress) return;
    if (state === "working") {
      // Time-based estimate, updated on every activity event.
      const elapsed = Math.max(0, Date.now() - since);
      const value = Math.min(0.95, 0.08 + (elapsed / 240_000) * 0.87).toFixed(
        2,
      );
      await run(
        this.bin,
        [
          "set-progress",
          value,
          "--label",
          `${label}: working`,
          ...this.target(),
        ],
        2000,
        this.signal,
      );
    } else if (state === "done") {
      await run(
        this.bin,
        ["set-progress", "1.00", "--label", `${label}: done`, ...this.target()],
        2000,
        this.signal,
      );
    } else if (changedState) {
      await run(
        this.bin,
        ["clear-progress", ...this.target()],
        2000,
        this.signal,
      );
    }
  }

  async notify(
    dir: string,
    state: "waiting" | "done" | "error",
    detail: string,
  ): Promise<boolean> {
    const label = this.label(dir);
    const title =
      state === "waiting"
        ? `OpenCode: input needed (${label})`
        : state === "error"
          ? `OpenCode: run failed (${label})`
          : `OpenCode: done (${label})`;
    const result = await run(
      this.bin,
      [
        "notify",
        "--title",
        title,
        "--body",
        clean(detail, 150) || state,
        ...this.target(),
      ],
      3000,
      this.signal,
    );
    if (!result.ok && !this.signal.aborted)
      this.diagnostic(
        `notify:${result.failure}`,
        `cmux notify ${result.failure}`,
      );
    return result.ok;
  }

  /** Remove every status/progress this instance ever set. */
  async clear(): Promise<void> {
    const signal = new AbortController().signal;
    const target = this.target();
    for (const key of this.touched) {
      await run(this.bin, ["clear-status", key, ...target], 1500, signal);
    }
    await run(this.bin, ["clear-progress", ...target], 1500, signal);
  }
}
