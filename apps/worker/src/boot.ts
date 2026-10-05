/**
 * What a worker does once, on start, before it claims anything, beyond recovering from a crash.
 *
 * Every step here runs on every deploy and every crash-loop restart, so each one is a single
 * statement, or nothing at all when there is nothing to do: a boot that walks the accounts one by
 * one is a boot that takes longer the more people use the product, at exactly the moment the
 * worker can least afford it.
 */
import { recordWorkerEvent, SEED_TAGS, type Db } from "@col/db";
import { DEFAULT_SETTINGS, GATE_REEVALUATION_VERSION, isKnownModel, type SystemSettings } from "@col/core";
import type { AiEngine } from "@col/ai";
import { sql } from "drizzle-orm";
import { log } from "./log";
import { getInternal, setInternal } from "./settings";

/**
 * Every model this deployment is configured to call: the default, the per-call-site overrides, the
 * stage routes, and each CV model an account has chosen (or the default one). One statement for
 * the accounts' choices, whatever their number.
 */
export async function configuredModels(db: Db, settings: Pick<SystemSettings, "defaultModel" | "modelOverrides" | "stageRoutes">): Promise<string[]> {
  const chosen = await db.execute<{ model: unknown }>(sql`select distinct value as model from user_settings where key = 'cvModel'`);
  const models = [
    settings.defaultModel,
    ...Object.values(settings.modelOverrides),
    ...Object.values(settings.stageRoutes).map(route => route?.model),
    DEFAULT_SETTINGS.cvModel,
    ...chosen.rows.map(row => row.model),
  ];
  // Only ids reading settings would let through: an unknown one is replaced by the default on read.
  return [...new Set(models.filter((model): model is string => typeof model === "string" && isKnownModel(model)))].sort();
}

/**
 * Prove, once per boot, that this key can reach every configured model. `models.retrieve` costs no
 * tokens. A model it cannot reach is a `model_access` worker event Health shows (and opens the
 * engine's breaker), rather than a day of calls failing one by one; nothing here stops the boot.
 * Returns the models that failed.
 */
export async function probeConfiguredModels(deps: { db: Db; ai: Pick<AiEngine, "probeModel">; settings(): Promise<SystemSettings> }, workerId: string): Promise<string[]> {
  const failed: string[] = [];
  try {
    const models = await configuredModels(deps.db, await deps.settings());
    for (const model of models) {
      const probe = await deps.ai.probeModel(model);
      if (!probe || probe.ok) continue;
      failed.push(model);
      log.warn("model unreachable with this key", { model, status: probe.status, message: probe.message });
      await recordWorkerEvent(deps.db, { workerId, kind: "model_access", detail: { model, message: probe.message, ...(probe.status !== undefined ? { status: probe.status } : {}), source: "boot" } });
    }
  } catch (err) {
    log.warn("model probe failed", err);
  }
  return failed;
}

/** Where the last gate version a boot applied is kept. */
export const GATE_REEVALUATION_KEY = "gateReevaluationVersion";

/**
 * Give every account the seed reason vocabulary, in one statement. New accounts get it when they
 * are created; this covers accounts from before a tag was added to the list.
 */
export async function seedTagVocabularies(db: Db): Promise<number> {
  const seeds = sql.join(SEED_TAGS.map(t => sql`(${t.tag}, ${t.description})`), sql`, `);
  const result = await db.execute(sql`insert into tag_vocabulary (user_id, tag, description, created_by)
    select u.id, seed.tag, seed.description, 'seed'
    from users u cross join (values ${seeds}) as seed(tag, description)
    where u.claimed_at is not null
    on conflict do nothing`);
  return result.rowCount ?? 0;
}

/**
 * Re-run every account's gate once when the gate's meaning has changed since the last boot that
 * did, and do nothing otherwise. Returns how many accounts were queued, or null when the stored
 * version already matches.
 *
 * One task per account, so each takes only its own lease, all in one statement. They carry
 * `reason: "boot"` and their own dedupe key: a person who changes their filters while one is
 * queued still gets their own re-evaluation at their own priority rather than being absorbed into
 * a row that waits behind everyone's requests, and ageing never lifts these level with a CV build.
 * The version is written in the same transaction as the tasks, under a lock, so two pods booting
 * together queue one set between them.
 */
export async function enqueueBootGateReevaluation(db: Db, version = GATE_REEVALUATION_VERSION): Promise<number | null> {
  return db.transaction(async tx => {
    const writer = tx as unknown as Db;
    await writer.execute(sql`select pg_advisory_xact_lock(hashtext('ava:gate-reevaluation'))`);
    if ((await getInternal<number>(writer, GATE_REEVALUATION_KEY)) === version) return null;
    const queued = await writer.execute(sql`insert into tasks (type, payload, dedupe_key, priority)
      select 'reevaluate_gate', jsonb_build_object('userId', u.id, 'reason', 'boot'), 'reevaluate_gate:' || u.id || ':boot', 7
      from users u where u.claimed_at is not null
      on conflict do nothing`);
    await setInternal(writer, GATE_REEVALUATION_KEY, version);
    const accounts = queued.rowCount ?? 0;
    log.info("gate semantics changed; re-evaluating every account", { version, accounts });
    return accounts;
  });
}
