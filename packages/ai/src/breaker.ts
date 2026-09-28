/**
 * A breaker per model id for failures that say this deployment cannot use the model at all.
 *
 * A request refused because the key cannot reach the model (401, 403, a 404 naming the model, a
 * 400 naming the workspace, a header or the model) fails the same way for every call that follows,
 * instantly and for nothing. Without a breaker each of those calls still queued for a stream,
 * took a budget hold and wrote a failed row: 157 of them in one month, each one a page classified
 * as "other" or a role marked scored with no score. After one such failure the model is refused
 * in-process for `MODEL_ACCESS_BREAKER_MS`, without a governor slot or a hold, and the trip is
 * logged once. When the window ends the next call is sent and, if the model is still unreachable,
 * trips it again.
 */
export const MODEL_ACCESS_BREAKER_MS = 10 * 60_000;

export interface BreakerTrip {
  model: string;
  /** The provider's message, cut to a line. */
  message: string;
  status?: number;
  trippedAt: number;
  openUntil: number;
  /** Calls refused while this trip was open. */
  refused: number;
}

export interface BreakerStats {
  /** Models refused right now. */
  open: BreakerTrip[];
  /** The most recent trip, open or not, so Health can say when it last happened. */
  last: BreakerTrip | null;
}

export class ModelAccessBreaker {
  private readonly trips = new Map<string, BreakerTrip>();
  private latest: BreakerTrip | null = null;
  private readonly listeners = new Set<(trip: BreakerTrip) => void>();

  /** Be told of each trip as it opens (not of the calls it then refuses). Returns the unsubscribe. */
  onTrip(listener: (trip: BreakerTrip) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  constructor(private readonly windowMs = MODEL_ACCESS_BREAKER_MS, private readonly now: () => number = Date.now) {}

  /** The open trip for `model`, counting the call it refuses, or null when calls may go. */
  refuse(model: string): BreakerTrip | null {
    const trip = this.trips.get(model);
    if (!trip) return null;
    if (trip.openUntil <= this.now()) {
      this.trips.delete(model);
      return null;
    }
    trip.refused++;
    return trip;
  }

  /** Open the breaker for `model`. True when this opened it; false when it was already open. */
  trip(model: string, message: string, status?: number): boolean {
    const now = this.now();
    const open = this.trips.get(model);
    if (open && open.openUntil > now) return false;
    const trip: BreakerTrip = { model, message: message.split("\n")[0]!.slice(0, 300), ...(status !== undefined ? { status } : {}), trippedAt: now, openUntil: now + this.windowMs, refused: 0 };
    this.trips.set(model, trip);
    this.latest = trip;
    for (const listener of this.listeners) {
      try {
        listener({ ...trip });
      } catch {
        // A listener that fails (a ledger write, say) must not fail the call that tripped it.
      }
    }
    return true;
  }

  stats(): BreakerStats {
    const now = this.now();
    return {
      open: [...this.trips.values()].filter(trip => trip.openUntil > now).map(trip => ({ ...trip })),
      last: this.latest ? { ...this.latest } : null,
    };
  }
}

/**
 * Whether a failure says the key cannot use the model, rather than that one request was wrong.
 * Every 401 and 403 does, and a 404 (the model, or the endpoint for it). A 400 does only when its
 * message names the model, the workspace, a header, the key or the organisation: a 400 for a
 * prompt that is too long, or a parameter out of range, is that request's own fault, and opening
 * the breaker on it would refuse every other call to a model that works.
 */
export function isModelAccessFailure(status: number | undefined, message: string): boolean {
  if (status === 401 || status === 403 || status === 404) return true;
  if (status !== 400) return false;
  return /\bmodel\b|workspace|anthropic-beta|\bheader\b|api[ _-]?key|organi[sz]ation|credit balance/i.test(message)
    && !/prompt is too long|max_tokens|too many tokens/i.test(message);
}

let processBreaker: ModelAccessBreaker | undefined;

/** The breaker every engine in this process shares when it built its own client. */
export function defaultBreaker(): ModelAccessBreaker {
  processBreaker ??= new ModelAccessBreaker();
  return processBreaker;
}

/** This process's open model-access breakers and its last trip, for Health. */
export function aiBreakerStats(): BreakerStats {
  return defaultBreaker().stats();
}
