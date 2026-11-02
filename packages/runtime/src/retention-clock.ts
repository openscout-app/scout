/**
 * The one retention clock: a rolling window of whole local days. Records stay
 * live for today and the previous `daysLive` days, so with the default of 7
 * a record is kept 7 to 8 days. The cutoff moves at each local midnight, so
 * rotation and archiving are a small daily piece of work, not a weekly burst.
 */

export type RetentionClock = {
  /** Whole local days kept before today. Minimum 1. */
  daysLive: number;
};

export const DEFAULT_RETENTION_DAYS = 7;

/** 00:00 machine-local of the day containing `now`, epoch ms. */
export function startOfLocalDay(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Oldest timestamp still live: local midnight `daysLive` days before today.
 * Date arithmetic keeps DST days whole, which fixed-ms jumps cannot.
 */
export function retentionCutoff(now: number, daysLive = DEFAULT_RETENTION_DAYS): number {
  const days = Number.isFinite(daysLive) ? Math.max(1, Math.floor(daysLive)) : 1;
  const date = new Date(startOfLocalDay(now));
  date.setDate(date.getDate() - days);
  return date.getTime();
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * ISO 8601 week key (`YYYY-Www`) for archive file names — Monday-start weeks,
 * week 1 contains the year's first Thursday.
 */
export function isoWeekKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  date.setHours(0, 0, 0, 0);
  // Shift to Thursday of this week: the ISO week-numbering year.
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const isoYear = date.getFullYear();
  const firstThursday = new Date(isoYear, 0, 4);
  firstThursday.setHours(0, 0, 0, 0);
  firstThursday.setDate(firstThursday.getDate() + 3 - ((firstThursday.getDay() + 6) % 7));
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / WEEK_MS);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** Absent, blank or invalid: undefined. "0": 0 (disabled). Otherwise at least 1. */
function parseCount(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (parsed === 0) return 0;
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.max(1, parsed);
}

function daysFrom(env: Record<string, string | undefined>, daysKey: string, weeksKey: string): number | undefined {
  const days = parseCount(env[daysKey]);
  if (days !== undefined) return days;
  // Earlier releases counted calendar weeks; a set value keeps its length.
  const weeks = parseCount(env[weeksKey]);
  return weeks === undefined ? undefined : weeks * 7;
}

/**
 * OPENSCOUT_RETENTION_DAYS: days of working records kept live in memory, the
 * journal and the registry sweep. Default 7, minimum 1; "0" disables rotation.
 * OPENSCOUT_RETENTION_WEEKS is still read, as whole weeks, when days is unset.
 */
export function resolveRetentionDays(
  env: Record<string, string | undefined> = process.env,
): number {
  return daysFrom(env, "OPENSCOUT_RETENTION_DAYS", "OPENSCOUT_RETENTION_WEEKS") ?? DEFAULT_RETENTION_DAYS;
}

/**
 * OPENSCOUT_ARCHIVE_DAYS: days SQLite keeps control-flow events before they
 * move to gzip archive files. Defaults to the retention window, so one clock
 * governs both unless set; "0" disables archiving. OPENSCOUT_ARCHIVE_WEEKS is
 * still read, as whole weeks, when days is unset.
 */
export function resolveArchiveDays(
  env: Record<string, string | undefined> = process.env,
): number {
  return daysFrom(env, "OPENSCOUT_ARCHIVE_DAYS", "OPENSCOUT_ARCHIVE_WEEKS") ?? resolveRetentionDays(env);
}
