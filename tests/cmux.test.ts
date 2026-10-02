import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CmuxAdapter, run } from "../src/cmux";
import plugin, { resolveDirectory } from "../src/index";
import {
  NotificationPolicy,
  StateMachine,
  type Transition,
} from "../src/state";

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0))
    await rm(dir, { recursive: true, force: true });
});

/** Create a fake `cmux` executable that records every invocation. */
async function fakeCmux(exit = 0) {
  const dir = await mkdtemp(join(tmpdir(), "oc-cmux-"));
  temporary.push(dir);
  const bin = join(dir, "cmux");
  await writeFile(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${dir}/calls'\nexit ${exit}\n`,
    { mode: 0o755 },
  );
  return {
    bin,
    calls: async (): Promise<string[]> => {
      try {
        const text = await Bun.file(join(dir, "calls")).text();
        return text.trim() ? text.trim().split("\n") : [];
      } catch {
        return [];
      }
    },
  };
}

function signalAwareStream(): {
  stream(signal: AbortSignal): AsyncIterable<unknown>;
  send(event: unknown): void;
  started(): boolean;
} {
  let send!: (event: unknown) => void;
  let started = false;
  return {
    stream(signal: AbortSignal): AsyncIterable<unknown> {
      return {
        async *[Symbol.asyncIterator]() {
          started = true;
          while (!signal.aborted) {
            const item = await new Promise<unknown>((resolve) => {
              send = resolve;
              signal.addEventListener("abort", () => resolve(undefined), {
                once: true,
              });
            });
            if (signal.aborted) break;
            yield item;
          }
        },
      };
    },
    send: (event: unknown) => send(event),
    started: () => started,
  };
}

test("unresolvable global event never uses plugin instance directory", async () => {
  const cache = new Map<string, string>();
  const session = {
    get: async () => {
      throw Error("not found");
    },
  };
  expect(
    await resolveDirectory(
      { sessionID: "missing", type: "session.idle" },
      cache,
      session,
    ),
  ).toBeUndefined();
  expect(
    await resolveDirectory({ type: "session.idle" }, cache, session),
  ).toBeUndefined();
  expect(
    await resolveDirectory({ sessionID: "A", directory: "/a" }, cache, session),
  ).toBe("/a");
  expect(await resolveDirectory({ sessionID: "A" }, cache, session)).toBe("/a");
});

test("run reports unavailable, timeout and generic failures", async () => {
  const signal = new AbortController().signal;
  expect(await run("no-such-oc-command", [], 100, signal)).toMatchObject({
    ok: false,
    failure: "unavailable",
  });
  expect(await run("sleep", ["1"], 10, signal)).toMatchObject({
    ok: false,
    failure: "timeout",
  });
  expect(await run("false", [], 1000, signal)).toMatchObject({
    ok: false,
    failure: "other",
  });
});

test("adapter stamps cmux status, progress, log and notification for the workspace", async () => {
  const { bin, calls } = await fakeCmux();
  const signal = new AbortController().signal;
  const adapter = new CmuxAdapter(
    bin,
    "test-ws",
    "opencode-",
    signal,
    () => {},
  );
  const project = "/tmp/test project/";
  const key = adapter.key(project);
  expect(key).toMatch(/^opencode-[0-9a-f]{8}$/);
  expect(adapter.key(project)).toBe(key);
  expect(adapter.label(project)).toBe("test project");

  await adapter.stamp(project, "working", 100_000, "tool\nread", true);
  await adapter.stamp(project, "done", 200_000, "done — your move", true);
  expect(await adapter.notify(project, "done", "done — your move")).toBe(true);
  await adapter.clear();

  const lines = await calls();
  expect(lines).toContain(
    `set-status ${key} test project: working --color #ff9500 --workspace test-ws`,
  );
  expect(lines).toContain(
    `set-status ${key} test project: done --color #34c759 --workspace test-ws`,
  );
  expect(
    lines.some(
      (line) =>
        line.startsWith("set-progress ") &&
        line.endsWith("--label test project: working --workspace test-ws"),
    ),
  ).toBe(true);
  expect(
    lines.some(
      (line) =>
        line.startsWith("set-progress 1.00 ") &&
        line.endsWith("--label test project: done --workspace test-ws"),
    ),
  ).toBe(true);
  expect(lines).toContain(
    "log --level progress --source opencode --workspace test-ws -- test project: tool read",
  );
  expect(
    lines.some(
      (line) =>
        line.startsWith("notify --title OpenCode: done (test project) ") &&
        line.endsWith("--workspace test-ws"),
    ),
  ).toBe(true);
  expect(lines).toContain(`clear-status ${key} --workspace test-ws`);
  expect(lines).toContain("clear-progress --workspace test-ws");
});

test("lifecycle: state sequence and notification dedupe", async () => {
  const { bin, calls } = await fakeCmux();
  const adapter = new CmuxAdapter(
    bin,
    "ws",
    "oc-",
    new AbortController().signal,
    () => {},
  );
  const machine = new StateMachine();
  const policy = new NotificationPolicy();
  const project = "/project";
  const apply = async (transition: Transition, at: number) => {
    const previous = machine.project.get(project);
    const next = machine.apply(project, "A", transition, at);
    if (!next) return;
    await adapter.stamp(
      project,
      next.state,
      next.since,
      next.detail,
      previous?.state !== next.state,
    );
    if (
      policy.eligible(project, next.state, next.detail, at) &&
      (next.state === "waiting" ||
        next.state === "done" ||
        next.state === "error") &&
      (await adapter.notify(project, next.state, next.detail))
    )
      policy.record(project, next.state, next.detail, at);
  };

  await apply({ signal: "created", detail: "ready" }, 1_000);
  await apply({ signal: "start", detail: "prompt sent" }, 2_000);
  await apply(
    { signal: "ask", detail: "permission edit", requestID: "p" },
    3_000,
  );
  await apply(
    { signal: "approve", detail: "permission approved", requestID: "p" },
    4_000,
  );
  await apply({ signal: "finish", detail: "done — your move" }, 5_000);
  await apply({ signal: "finish", detail: "done — your move" }, 5_001);
  await apply({ signal: "start", detail: "new prompt" }, 6_000);
  await apply({ signal: "fail", detail: "run failed" }, 7_000);
  await apply({ signal: "finish", detail: "done — your move" }, 8_000);

  const lines = await calls();
  const states = lines
    .filter((line) => line.startsWith("set-status "))
    .map((line) => /: ([a-z]+) --color/.exec(line)?.[1]);
  expect(states).toEqual([
    "idle",
    "working",
    "waiting",
    "working",
    "done",
    "working",
    "error",
  ]);
  expect(lines.filter((line) => line.startsWith("notify "))).toHaveLength(3);
});

test("ignores events for a different location", async () => {
  const { bin, calls } = await fakeCmux();
  const callbacks = new Map<string, (event: unknown) => void>();
  const ctx = {
    options: { bin, workspace: "ws", notifications: false },
    session: {
      get: async () => ({ location: { directory: "/location-b" } }),
      hook: async (name: string, callback: (event: unknown) => void) => {
        callbacks.set(name, callback);
        return { dispose: async () => {} };
      },
    },
    tool: {
      hook: async (name: string, callback: (event: unknown) => void) => {
        callbacks.set(name, callback);
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe: ({
        signal,
      }: {
        signal: AbortSignal;
      }): AsyncIterable<unknown> =>
        ({
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((resolve) => {
              if (signal.aborted) return resolve();
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
          },
        }) as AsyncIterable<unknown>,
    },
    location: { directory: "/location-a" },
  } as unknown as Parameters<typeof plugin.setup>[0];

  const cleanup = await plugin.setup(ctx);
  callbacks.get("prompt")?.({ sessionID: "B", delivery: "steer" });
  await Bun.sleep(50);
  expect(
    (await calls()).filter((line) => line.startsWith("set-status ")),
  ).toHaveLength(0);
  if (cleanup) await cleanup();
});

test("setup wires hooks and stream, then cleanup clears cmux state", async () => {
  const { bin, calls } = await fakeCmux();
  const project = join(tmpdir(), "opencode", "cmux-queue-project");
  const { stream, send, started } = signalAwareStream();
  let release!: (value: { location: { directory: string } }) => void;
  const lookup = new Promise<{ location: { directory: string } }>((resolve) => {
    release = resolve;
  });
  const callbacks = new Map<string, (event: unknown) => void>();
  let disposeCount = 0;
  const ctx = {
    options: { bin, workspace: "test-ws", notifications: false },
    session: {
      get: async () => lookup,
      hook: async (name: string, callback: (event: unknown) => void) => {
        callbacks.set(name, callback);
        return {
          dispose: async () => {
            disposeCount++;
          },
        };
      },
    },
    tool: {
      hook: async (name: string, callback: (event: unknown) => void) => {
        callbacks.set(name, callback);
        return {
          dispose: async () => {
            disposeCount++;
          },
        };
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => stream(signal),
    },
    location: { directory: project },
  } as unknown as Parameters<typeof plugin.setup>[0];

  const cleanup = await plugin.setup(ctx);
  expect(cleanup).toBeFunction();
  expect(started()).toBe(true);
  callbacks.get("prompt")?.({ sessionID: "A", delivery: "steer" });
  send({
    type: "session.idle",
    location: { directory: project },
    data: { sessionID: "A" },
  });
  release({ location: { directory: project } });

  const done = async () =>
    (await calls()).some((line) => /: done --color/.test(line));
  for (let attempt = 0; attempt < 200 && !(await done()); attempt++)
    await Bun.sleep(10);
  expect(await done()).toBe(true);

  if (cleanup) await cleanup();
  expect(disposeCount).toBe(2);
  const lines = await calls();
  expect(lines.some((line) => line.startsWith("clear-status "))).toBe(true);
  expect(lines).toContain("clear-progress --workspace test-ws");
});
