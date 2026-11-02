import { describe, expect, test } from "bun:test";

import {
  isoWeekKey,
  resolveArchiveDays,
  resolveRetentionDays,
  retentionCutoff,
  startOfLocalDay,
} from "./retention-clock.ts";

// Local-time helpers: these tests assert machine-local midnight boundaries, so
// expected values are built with the same Date constructor semantics instead
// of fixed epoch constants.
function localDate(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month, day, hour, minute).getTime();
}

describe("startOfLocalDay", () => {
  test("returns local midnight of the same day", () => {
    expect(startOfLocalDay(localDate(2026, 10, 2, 15, 30))).toBe(localDate(2026, 10, 2));
    expect(startOfLocalDay(localDate(2026, 10, 2))).toBe(localDate(2026, 10, 2));
    expect(startOfLocalDay(localDate(2026, 10, 2, 23, 59))).toBe(localDate(2026, 10, 2));
  });
});

describe("retentionCutoff", () => {
  test("keeps today and the previous seven whole days by default", () => {
    expect(retentionCutoff(localDate(2026, 10, 2, 15))).toBe(localDate(2026, 9, 26));
    expect(retentionCutoff(localDate(2026, 10, 2, 0, 0))).toBe(localDate(2026, 9, 26));
  });

  test("moves one day at each local midnight, never in weekly jumps", () => {
    const monday = retentionCutoff(localDate(2026, 10, 2, 23, 59), 7);
    const tuesday = retentionCutoff(localDate(2026, 10, 3, 0, 1), 7);
    expect(tuesday).toBe(localDate(2026, 9, 27));
    expect(tuesday - monday).toBe(24 * 60 * 60 * 1_000);
  });

  test("crosses a month boundary and clamps the day count", () => {
    expect(retentionCutoff(localDate(2026, 10, 2), 3)).toBe(localDate(2026, 9, 30));
    expect(retentionCutoff(localDate(2026, 10, 2), 0)).toBe(localDate(2026, 10, 1));
    expect(retentionCutoff(localDate(2026, 10, 2), Number.NaN)).toBe(localDate(2026, 10, 1));
  });

  test("a DST day stays whole", () => {
    // US DST ends 2026-11-01; the cutoff is still a local midnight.
    const cutoff = retentionCutoff(localDate(2026, 10, 3, 12), 2);
    expect(cutoff).toBe(localDate(2026, 10, 1));
    expect(new Date(cutoff).getHours()).toBe(0);
  });
});

describe("isoWeekKey", () => {
  test("assigns the ISO week-year and week number", () => {
    // 2026-09-21 is Monday of ISO week 39.
    expect(isoWeekKey(localDate(2026, 8, 21))).toBe("2026-W39");
    // Same ISO week through Sunday.
    expect(isoWeekKey(localDate(2026, 8, 27, 23, 59))).toBe("2026-W39");
    // The following Monday starts W40.
    expect(isoWeekKey(localDate(2026, 8, 28))).toBe("2026-W40");
  });

  test("year-boundary dates belong to the adjacent ISO year", () => {
    // 2026-01-01 is a Thursday → ISO 2026-W01.
    expect(isoWeekKey(localDate(2026, 0, 1))).toBe("2026-W01");
    // 2025-12-29 is a Monday of ISO 2026-W01 (week containing Jan 1 2026).
    expect(isoWeekKey(localDate(2025, 11, 29))).toBe("2026-W01");
    // 2025-12-28 (Sunday) is still ISO 2025-W52.
    expect(isoWeekKey(localDate(2025, 11, 28))).toBe("2025-W52");
  });
});

describe("resolveRetentionDays / resolveArchiveDays", () => {
  test("default to seven days, with archiving on the same clock", () => {
    expect(resolveRetentionDays({})).toBe(7);
    expect(resolveArchiveDays({})).toBe(7);
    expect(resolveArchiveDays({ OPENSCOUT_RETENTION_DAYS: "3" })).toBe(3);
    expect(resolveArchiveDays({ OPENSCOUT_RETENTION_DAYS: "3", OPENSCOUT_ARCHIVE_DAYS: "10" })).toBe(10);
  });

  test("read the earlier week settings as whole weeks when days are unset", () => {
    expect(resolveRetentionDays({ OPENSCOUT_RETENTION_WEEKS: "2" })).toBe(14);
    expect(resolveArchiveDays({ OPENSCOUT_ARCHIVE_WEEKS: "4" })).toBe(28);
    expect(resolveRetentionDays({ OPENSCOUT_RETENTION_DAYS: "5", OPENSCOUT_RETENTION_WEEKS: "2" })).toBe(5);
  });

  test("zero disables, invalid values fall back", () => {
    expect(resolveRetentionDays({ OPENSCOUT_RETENTION_DAYS: "0" })).toBe(0);
    expect(resolveArchiveDays({ OPENSCOUT_ARCHIVE_DAYS: "0" })).toBe(0);
    expect(resolveRetentionDays({ OPENSCOUT_RETENTION_WEEKS: "0" })).toBe(0);
    expect(resolveRetentionDays({ OPENSCOUT_RETENTION_DAYS: "-3" })).toBe(7);
    expect(resolveRetentionDays({ OPENSCOUT_RETENTION_DAYS: "bogus" })).toBe(7);
    expect(resolveRetentionDays({ OPENSCOUT_RETENTION_DAYS: "  " })).toBe(7);
  });
});
