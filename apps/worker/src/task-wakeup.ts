/**
 * The queue's wake-up call: one dedicated connection that LISTENs on `ava_tasks`, so an idle slot
 * claims a new task the moment its enqueue commits instead of on its next poll.
 *
 * Every enqueue (`enqueueTask`/`enqueueTasks`) issues `pg_notify('ava_tasks', '')` in its own
 * transaction, which Postgres delivers on commit and drops on rollback. The notification carries
 * nothing: it only says "claim now", and the claim decides what. So nothing is lost by missing one
 * — the queue keeps a slower fallback poll — and the listener's own failures never stop the queue:
 * a dropped connection is reconnected with a growing backoff, and every (re)connect wakes the
 * slots once, to pick up whatever was enqueued while nobody was listening.
 *
 * The connection is a plain `pg.Client` on the direct URL, outside the pool: LISTEN needs a session
 * of its own, which a transaction-pooling PgBouncer cannot give and a pooled connection would lose.
 */
import pg from "pg";
import { TASKS_CHANNEL } from "@ava/db";
import { log } from "./log";

/** Reconnect waits: 1 s, doubling to 30 s. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** The same SSL rule the pool uses: off for a local or internal host, required (unverified) elsewhere. */
function sslFor(connectionString: string): pg.ClientConfig["ssl"] {
  const mode = process.env.DATABASE_SSL;
  if (mode === "disable") return undefined;
  if (mode === "verify") return { rejectUnauthorized: true };
  if (mode === "require") return { rejectUnauthorized: false };
  try {
    const host = new URL(connectionString).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".internal")) return undefined;
  } catch {
    /* fall through */
  }
  return { rejectUnauthorized: false };
}

export class TaskWakeup {
  private client: pg.Client | null = null;
  private stopped = false;
  private reconnectMs = RECONNECT_MIN_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private waiters = new Set<() => void>();
  private connected = false;

  constructor(private readonly connectionString: string) {}

  /** Whether notifications are arriving now, which is what lets the queue poll less often. */
  get listening(): boolean {
    return this.connected;
  }

  start(): void {
    void this.connect();
  }

  /** Resolves after `ms`, or as soon as a notification (or a reconnect) arrives. */
  wait(ms: number): Promise<void> {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.waiters.add(done);
    });
  }

  /** Wake every waiting slot. */
  wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.connected = false;
    const client = this.client;
    this.client = null;
    this.wake();
    if (client) await client.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.connectionString, ssl: sslFor(this.connectionString), keepAlive: true });
    this.client = client;
    const lost = (reason: string) => {
      if (this.client !== client) return;
      this.client = null;
      this.connected = false;
      void client.end().catch(() => undefined);
      if (this.stopped) return;
      log.warn("task listener lost; reconnecting", { reason, inMs: this.reconnectMs });
      this.reconnectTimer = setTimeout(() => void this.connect(), this.reconnectMs);
      this.reconnectTimer.unref?.();
      this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
    };
    client.on("error", error => lost(error.message));
    client.on("end", () => lost("connection ended"));
    client.on("notification", message => { if (message.channel === TASKS_CHANNEL) this.wake(); });
    try {
      await client.connect();
      await client.query(`LISTEN ${TASKS_CHANNEL}`);
    } catch (error) {
      lost((error as Error).message);
      return;
    }
    if (this.stopped) { await client.end().catch(() => undefined); return; }
    this.connected = true;
    this.reconnectMs = RECONNECT_MIN_MS;
    // Whatever was enqueued while nobody was listening: every slot looks once.
    this.wake();
  }
}
