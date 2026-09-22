import assert from "node:assert/strict";
import { test } from "node:test";
import { isoWeek, isoWeekName, isoWeekStart, localDate } from "../../src/vault/dates.js";

test("dates use the configured zone, not UTC or the machine zone", () => {
  assert.equal(localDate(new Date("2026-01-05T02:00:00Z"), "America/New_York"), "2026-01-04");
  assert.equal(localDate(new Date("2026-01-05T02:00:00Z"), "UTC"), "2026-01-05");
  assert.equal(localDate(new Date("2026-01-04T23:30:00Z"), "Asia/Tokyo"), "2026-01-05");
});

test("ISO week-year math", () => {
  assert.deepEqual(isoWeek("2026-01-01"), { year: 2026, week: 1 });
  assert.equal(isoWeekName("2027-01-01"), "2026-W53");
  assert.equal(isoWeekName("2024-12-30"), "2025-W01");
  assert.equal(isoWeekName("2021-01-03"), "2020-W53");
  assert.equal(isoWeekName("2026-09-22"), "2026-W39");
  assert.equal(isoWeekStart("2026-09-27"), "2026-09-21");
});
