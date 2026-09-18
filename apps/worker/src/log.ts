import { AsyncLocalStorage } from "node:async_hooks";

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;

/** What the line was emitted for. Everything logged while a task runs carries its id and type. */
export interface LogContext {
  taskId: string;
  taskType: string;
}

/**
 * The task a line belongs to, carried implicitly. A scan logs from the fetcher, the browser, the
 * adapters and half a dozen helpers, none of which are given the task; without this, reading back
 * which requests a failed task made means guessing from timestamps in an interleaved stream.
 */
const context = new AsyncLocalStorage<LogContext>();

/** Run `fn` with every line it emits — at any depth, across awaits — tagged with `ctx`. */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  return context.run(ctx, fn);
}

function emit(level: Level, msg: string, data?: unknown) {
  if (LEVELS[level] < threshold) return;
  const line: Record<string, unknown> = { t: new Date().toISOString(), level, msg };
  const active = context.getStore();
  if (active) {
    line.taskId = active.taskId;
    line.taskType = active.taskType;
  }
  if (data !== undefined) line.data = data instanceof Error ? { name: data.name, message: data.message, stack: data.stack } : data;
  const out = JSON.stringify(line);
  if (level === "error" || level === "warn") process.stderr.write(out + "\n");
  else process.stdout.write(out + "\n");
}

export const log = {
  debug: (msg: string, data?: unknown) => emit("debug", msg, data),
  info: (msg: string, data?: unknown) => emit("info", msg, data),
  warn: (msg: string, data?: unknown) => emit("warn", msg, data),
  error: (msg: string, data?: unknown) => emit("error", msg, data),
  child: (prefix: string) => ({
    debug: (msg: string, data?: unknown) => emit("debug", `${prefix} ${msg}`, data),
    info: (msg: string, data?: unknown) => emit("info", `${prefix} ${msg}`, data),
    warn: (msg: string, data?: unknown) => emit("warn", `${prefix} ${msg}`, data),
    error: (msg: string, data?: unknown) => emit("error", `${prefix} ${msg}`, data),
  }),
};
export type Logger = typeof log;
