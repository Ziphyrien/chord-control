export type LoadingSamples = Readonly<Record<string, readonly number[]>>;

export interface LoadingProfileStore {
  read(): LoadingSamples;
  write(samples: LoadingSamples): void;
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

const normalizeSamples = (samples: readonly unknown[]): number[] =>
  samples.filter(validDuration).slice(-PROFILE_SAMPLE_LIMIT);

const normalizeProfile = (profile: LoadingSamples): Record<string, number[]> =>
  Object.fromEntries(
    Object.entries(profile)
      .map(([channel, samples]) => [channel, normalizeSamples(samples)] as const)
      .filter(([, samples]) => samples.length),
  );

const parseProfile = (value: unknown): Record<string, number[]> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const samples = (value as StoredProfile).samples;
  if (Array.isArray(samples)) return { connection: normalizeSamples(samples) };
  if (!samples || typeof samples !== "object" || Array.isArray(samples)) return {};
  return normalizeProfile(samples as LoadingSamples);
};

const browserStore: LoadingProfileStore = {
  read() {
    try {
      const storage = browserStorage();
      if (!storage) return {};
      return parseProfile(JSON.parse(storage.getItem(PROFILE_KEY) ?? "null"));
    } catch {
      return {};
    }
  },
  write(samples) {
    try {
      const storage = browserStorage();
      if (!storage) return;
      storage.setItem(PROFILE_KEY, JSON.stringify({ samples: normalizeProfile(samples) }));
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
 * Learns each controller interaction's actual response distribution instead of
 * assigning an eager spinner to every action. The cold-start budget is the
 * only prior; later interactions use persisted percentiles from observations.
 */
export class AdaptiveLoadingPolicy {
  private samples: Record<string, number[]>;

  constructor(private readonly store: LoadingProfileStore = browserStore) {
    this.samples = normalizeProfile(store.read());
  }

  /** Hide visual feedback for the normal tail of observed responses. */
  revealDelay(channel = "connection"): number {
    return Math.max(
      COLD_START_BUDGET_MS,
      Math.round(percentile(this.samples[channel] ?? [], 0.75)),
    );
  }

  /** Hysteresis is learned per interaction; it is not a second eager timeout. */
  settleDelay(channel = "connection"): number {
    return Math.max(COLD_START_BUDGET_MS, Math.round(percentile(this.samples[channel] ?? [], 0.5)));
  }

  observe(channel: string, duration: number): void {
    if (!validDuration(duration)) return;
    this.samples[channel] = [...(this.samples[channel] ?? []), duration].slice(
      -PROFILE_SAMPLE_LIMIT,
    );
    this.store.write(this.samples);
  }
}
