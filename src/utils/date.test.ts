/**
 * Tests for date formatting utilities
 *
 * Node re-reads process.env.TZ at runtime, so each case pins a timezone
 * to make the local-time output and offset deterministic.
 */

import { describe, it, expect, afterEach } from "vitest";
import { formatTimestamp } from "./date.js";

const originalTz = process.env.TZ;

function withTimezone(tz: string) {
  process.env.TZ = tz;
}

describe("formatTimestamp", () => {
  afterEach(() => {
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  });

  it("formats local time with a positive offset", () => {
    withTimezone("Europe/London");
    const date = new Date(2026, 8, 29, 17, 19, 18); // BST
    expect(formatTimestamp(date)).toBe("2026-09-29T17:19:18+01:00");
  });

  it("formats local time with a negative offset", () => {
    withTimezone("America/New_York");
    const date = new Date(2026, 8, 29, 7, 5, 9); // EDT
    expect(formatTimestamp(date)).toBe("2026-09-29T07:05:09-04:00");
  });

  it("formats UTC as +00:00", () => {
    withTimezone("UTC");
    const date = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(formatTimestamp(date)).toBe("2026-01-01T00:00:00+00:00");
  });

  it("handles non-hour offsets", () => {
    withTimezone("Asia/Kolkata");
    expect(formatTimestamp(new Date(2026, 2, 15, 9, 30, 0))).toBe("2026-03-15T09:30:00+05:30");

    withTimezone("America/St_Johns");
    expect(formatTimestamp(new Date(2026, 0, 15, 9, 30, 0))).toBe("2026-01-15T09:30:00-03:30");
  });

  it("reflects DST changes in the offset", () => {
    withTimezone("Europe/London");
    expect(formatTimestamp(new Date(2026, 0, 15, 12, 0, 0))).toBe("2026-01-15T12:00:00+00:00");
    expect(formatTimestamp(new Date(2026, 6, 15, 12, 0, 0))).toBe("2026-07-15T12:00:00+01:00");
  });

  it("round-trips to the same instant", () => {
    const instant = Date.UTC(2026, 8, 29, 16, 19, 18);
    for (const tz of ["UTC", "Europe/London", "America/Los_Angeles", "Asia/Tokyo"]) {
      withTimezone(tz);
      expect(new Date(formatTimestamp(new Date(instant))).getTime()).toBe(instant);
    }
  });
});
