# Changelog

## 0.1.0

Forked from
[`4m1z/opencode-tmux-session-status`](https://github.com/4m1z/opencode-tmux-session-status)
(MIT).

### Changed

- Replaced the tmux backend with cmux sidebar commands:
  `set-status` / `clear-status`, `set-progress` / `clear-progress`, `log`,
  `notify`.
- Status pills are keyed per project directory using
  `<statusKeyPrefix>` + first 8 hex characters of the directory SHA-1 instead
  of tmux session names and `cksum`.
- Configurable `statusKeyPrefix` option (default `opencode-`).
- Progress bar is driven while `working` and set to 100% on `done`.
- The plugin instance only handles events for the location it was loaded for,
  so multiple project locations no longer write duplicate statuses, logs or
  notifications.
- Requires `CMUX_WORKSPACE_ID` (or an explicit `workspace` option); no-op
  otherwise.

### Removed

- tmux session/option handling, `omarchy` / `notify-send` notifiers, and the
  tmux `ack.sh` acknowledgement workflow (`done` persists until the next
  prompt).

### Upstream

- State machine (`src/state.ts`), event decoding (`src/events.ts`) and hook
  wiring (`src/index.ts`) are based on the upstream implementation.
