// opencode-cmux-status
//
// OpenCode 2 plugin that surfaces agent activity in the cmux sidebar.
// Adapted from opencode-tmux-session-status (MIT, 4m1z) — only the output
// adapter changed (tmux -> cmux). State machine, event decoding and hook
// wiring follow upstream.
//
// The plugin is a no-op outside cmux: it needs CMUX_WORKSPACE_ID (or an
// explicit `workspace` option) to know which cmux workspace to update.

import { resolve as resolvePath } from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import { CmuxAdapter, clean } from "./cmux";
import { decode, nonempty, type Decoded } from "./events";
import { NotificationPolicy, StateMachine, type Transition } from "./state";

type SessionLookup = Pick<Context["session"], "get">;

export async function resolveDirectory(
  event: Decoded,
  cache: Map<string, string>,
  session: SessionLookup,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const explicit = nonempty(event.directory);
  if (explicit) {
    if (event.sessionID) cache.set(event.sessionID, explicit);
    return explicit;
  }
  if (!event.sessionID) return;
  const cached = cache.get(event.sessionID);
  if (cached) return cached;
  try {
    const info = await session.get({ sessionID: event.sessionID }, { signal });
    const dir = nonempty(info.location.directory);
    if (dir) cache.set(event.sessionID, dir);
    return dir;
  } catch {
    return;
  }
}

export default {
  id: "cmux-status",
  async setup(ctx: Context) {
    const o = (ctx.options ?? {}) as Record<string, unknown>;
    const controller = new AbortController();
    const debug = o.debug === true;
    const debugAt = new Map<string, number>();
    const diagnostic = (key: string, message: string) => {
      if (
        !debug ||
        controller.signal.aborted ||
        Date.now() - (debugAt.get(key) ?? -Infinity) < 60_000
      )
        return;
      debugAt.set(key, Date.now());
      console.error(`[cmux-status] ${message}`);
    };

    const workspace =
      nonempty(o.workspace) ?? nonempty(process.env["CMUX_WORKSPACE_ID"]);
    if (!workspace) {
      diagnostic(
        "cmux",
        "CMUX_WORKSPACE_ID is not set and no workspace option was provided; plugin disabled",
      );
      return;
    }

    const adapter = new CmuxAdapter(
      nonempty(o.bin) ?? nonempty(process.env["OPENCODE_CMUX_BIN"]) ?? "cmux",
      workspace,
      nonempty(o.statusKeyPrefix) ?? "opencode-",
      controller.signal,
      diagnostic,
      o.progress !== false,
      o.logs !== false,
    );
    const machine = new StateMachine();
    const notifications = new NotificationPolicy(
      typeof o.notificationCooldownMs === "number" &&
        Number.isFinite(o.notificationCooldownMs) &&
        o.notificationCooldownMs >= 0
        ? o.notificationCooldownMs
        : 120_000,
      typeof o.changedDetailFloorMs === "number" &&
        Number.isFinite(o.changedDetailFloorMs) &&
        o.changedDetailFloorMs >= 0
        ? o.changedDetailFloorMs
        : 15_000,
    );
    // OpenCode instantiates a plugin once per location while every instance
    // sees the whole server event stream. Only react to the location this
    // instance was loaded for, otherwise every location would write the same
    // status/log/notification.
    const locationDir = nonempty(ctx.location?.directory);
    const owns = (dir: string) =>
      !locationDir || resolvePath(dir) === resolvePath(locationDir);

    const directories = new Map<string, string>();
    let queue: Promise<void> = Promise.resolve();

    const enqueue = (event: Decoded) => {
      // Both hooks and the one subscription enter the same FIFO before any
      // directory lookup, hash or subprocess can yield and reorder them.
      queue = queue
        .then(async () => {
          if (controller.signal.aborted) return;
          if (!event.transition || !event.sessionID) {
            diagnostic(
              "malformed",
              `ignored malformed ${event.type || "event"}`,
            );
            return;
          }
          const dir = await resolveDirectory(
            event,
            directories,
            ctx.session,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          if (!dir) {
            diagnostic("directory", "unresolved session directory");
            return;
          }
          if (!owns(dir)) {
            diagnostic(
              "location",
              `ignored ${event.type || "event"} for another location`,
            );
            return;
          }
          const before = machine.project.get(dir);
          const next = machine.apply(
            dir,
            event.sessionID,
            event.transition,
            Date.now(),
          );
          if (!next) {
            diagnostic(
              "transition",
              `ignored stale/invalid ${event.type || "event"}`,
            );
            return;
          }
          const detail = clean(next.detail, 120);
          await adapter.stamp(
            dir,
            next.state,
            next.since,
            detail,
            before?.state !== next.state,
          );
          if (controller.signal.aborted || o.notifications === false) return;
          if (!notifications.eligible(dir, next.state, detail, Date.now()))
            return;
          if (
            next.state !== "waiting" &&
            next.state !== "done" &&
            next.state !== "error"
          )
            return;
          if (
            await adapter.notify(
              dir,
              next.state,
              o.notificationDetail === "state" ? next.state : detail,
            )
          )
            notifications.record(dir, next.state, detail, Date.now());
        })
        .catch(() => diagnostic("event", "state update failed"));
    };

    const hookTransition = (sessionID: string, transition: Transition) =>
      enqueue({ sessionID, transition, type: `hook.${transition.signal}` });
    const registrations: Array<{ dispose(): Promise<void> }> = [];
    try {
      registrations.push(
        await ctx.session.hook("prompt", (event) => {
          // Queue admission does not mean the agent has started executing.
          if (event.delivery !== "queue")
            hookTransition(event.sessionID, {
              signal: "start",
              detail: "prompt sent",
            });
        }),
      );
      registrations.push(
        await ctx.tool.hook("execute.before", (event) => {
          hookTransition(event.sessionID, {
            signal: "activity",
            detail: `tool ${event.tool}`,
          });
        }),
      );
    } catch {
      diagnostic("hooks", "hook registration failed");
    }
    const subscription = (async () => {
      try {
        for await (const raw of ctx.event.subscribe({
          signal: controller.signal,
        })) {
          const event = decode(raw);
          if (event.transition) enqueue(event);
        }
      } catch {
        if (!controller.signal.aborted)
          diagnostic("subscription", "event subscription failed");
      }
    })();

    return async () => {
      controller.abort();
      await Promise.allSettled(
        registrations.map((registration) => registration.dispose()),
      );
      await subscription;
      await queue;
      await adapter.clear();
    };
  },
};
