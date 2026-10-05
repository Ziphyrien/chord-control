export interface LoadingProfileStore {
  read(): readonly number[];
  write(samples: readonly number[]): void;
}

const PROFILE_KEY = "chord-control.loading-profile.v1";
const PROFILE_SAMPLE_LIMIT = 24;
const COLD_START_BUDGET_MS = 240;
const MAX_RECORDED_DURATION_MS = 20_000;

type StoredProfile = { samples?: unknown };

const browserStorage = (): Storage | undefined => {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

const validDuration = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value > 0 &&
  value <= MAX_RECORDED_DURATION_MS;

const normalize = (samples: readonly unknown[]): number[] =>
  samples.filter(validDuration).slice(-PROFILE_SAMPLE_LIMIT);

const browserStore: LoadingProfileStore = {
  read() {
    try {
      const storage = browserStorage();
      if (!storage) return [];
      const parsed: unknown = JSON.parse(storage.getItem(PROFILE_KEY) ?? "null");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
      const samples = (parsed as StoredProfile).samples;
      return Array.isArray(samples) ? normalize(samples) : [];
    } catch {
      return [];
    }
  },
  write(samples) {
    try {
      const storage = browserStorage();
      if (!storage) return;
      storage.setItem(PROFILE_KEY, JSON.stringify({ samples: normalize(samples) }));
    } catch {
      // Storage can be unavailable in private/browser-preview contexts; memory still adapts.
    }
  },
};

const percentile = (samples: readonly number[], rank: number): number => {
  if (!samples.length) return COLD_START_BUDGET_MS;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * rank) - 1));
  return sorted[index];
};

/**
 * Learns the controller's actual response distribution instead of assigning a
 * spinner delay to every startup. The cold-start budget is the only prior;
 * later sessions use persisted percentiles from real controller observations.
 */
export class AdaptiveLoadingPolicy {
  private samples: number[];

  constructor(private readonly store: LoadingProfileStore = browserStore) {
    this.samples = normalize(store.read());
  }

  /** Hide the indicator for the normal tail of observed responses. */
  revealDelay(): number {
    return Math.max(COLD_START_BUDGET_MS, Math.round(percentile(this.samples, 0.75)));
  }

  /** Hysteresis is also learned; it is not a second arbitrary timeout. */
  settleDelay(): number {
    return Math.max(COLD_START_BUDGET_MS, Math.round(percentile(this.samples, 0.5)));
  }

  observe(duration: number): void {
    if (!validDuration(duration)) return;
    this.samples = [...this.samples, duration].slice(-PROFILE_SAMPLE_LIMIT);
    this.store.write(this.samples);
  }
}
