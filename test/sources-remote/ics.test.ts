import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  expandEvents,
  parseDuration,
  parseIcs,
  parseLine,
  resolveZone,
  unfold,
  zonedToUtc,
  type IcsEvent,
} from "../../src/sources/ics.js";

const ICS_PATH = join(import.meta.dirname, "..", "fixtures", "remote", "calendar.ics");
const ICS = readFileSync(ICS_PATH, "utf8");
const TZ = "Europe/Paris";

const iso = (d: Date) => d.toISOString();

describe("ics parsing", () => {
  it("unfolds continuation lines", () => {
    assert.deepEqual(unfold("A:one\r\n  two\r\n\tthree\r\nB:x"), ["A:one twothree", "B:x"]);
  });

  it("parses params with quoted colons", () => {
    const p = parseLine('ATTENDEE;CN="Doe: Jane";PARTSTAT=ACCEPTED:mailto:jane@acme.example');
    assert.deepEqual(p, {
      name: "ATTENDEE",
      params: { CN: "Doe: Jane", PARTSTAT: "ACCEPTED" },
      value: "mailto:jane@acme.example",
    });
  });

  it("parses durations", () => {
    assert.equal(parseDuration("PT1H30M"), 90 * 60_000);
    assert.equal(parseDuration("P1D"), 86_400_000);
    assert.equal(parseDuration("-P0DT0H10M0S"), -600_000);
  });

  it("reads events, ignoring VALARM and VTIMEZONE", () => {
    const events = parseIcs(ICS, TZ);
    assert.equal(events.length, 10);
    const kickoff = events.find((e) => e.uid === "utc-kickoff@synthetic.example")!;
    assert.equal(kickoff.description, "Agenda: review Q1 numbers and the partnership pipeline\nSecond line, with comma");
    assert.deepEqual(kickoff.organizer, { email: "alex@mycorp.example", name: "Alex Rivera", partstat: undefined, cutype: undefined, role: undefined });
    assert.equal(kickoff.attendees.length, 3);
    assert.equal(kickoff.attendees[0]?.name, "Doe: Jane");
    assert.equal(kickoff.attendees[2]?.cutype, "RESOURCE");
    assert.equal(kickoff.status, "CONFIRMED");
  });
});

describe("time zones", () => {
  it("converts TZID wall-clock times with Intl", () => {
    assert.equal(iso(new Date(zonedToUtc({ y: 2024, m: 3, d: 4, hh: 15, mm: 0, ss: 0 }, "Europe/Paris"))), "2024-03-04T14:00:00.000Z");
    assert.equal(iso(new Date(zonedToUtc({ y: 2024, m: 7, d: 4, hh: 15, mm: 0, ss: 0 }, "Europe/Paris"))), "2024-07-04T13:00:00.000Z");
    assert.equal(iso(new Date(zonedToUtc({ y: 2024, m: 3, d: 11, hh: 10, mm: 0, ss: 0 }, "America/New_York"))), "2024-03-11T14:00:00.000Z");
  });

  it("maps Windows and prefixed TZIDs, falling back otherwise", () => {
    assert.equal(resolveZone("Romance Standard Time", "UTC"), "Europe/Paris");
    assert.equal(resolveZone("/citadel.org/20070101_1/Europe/Berlin", "UTC"), "Europe/Berlin");
    assert.equal(resolveZone('"America/New_York"', "UTC"), "America/New_York");
    assert.equal(resolveZone("Mars/Olympus_Mons", "Asia/Tokyo"), "Asia/Tokyo");
  });
});

describe("expandEvents", () => {
  const events = parseIcs(ICS, TZ);
  const occ = (since: string, until: string, uid?: string) =>
    expandEvents(events, new Date(since), new Date(until)).filter((o) => !uid || o.event.uid === uid);

  it("handles UTC, TZID and all-day events", () => {
    const [kick] = occ("2024-03-04T00:00:00Z", "2024-03-08T00:00:00Z", "utc-kickoff@synthetic.example");
    assert.equal(iso(kick!.start), "2024-03-04T09:00:00.000Z");
    assert.equal(iso(kick!.end), "2024-03-04T09:30:00.000Z");

    const [paris] = occ("2024-03-04T00:00:00Z", "2024-03-08T00:00:00Z", "paris-lunch@synthetic.example");
    assert.equal(iso(paris!.start), "2024-03-04T14:00:00.000Z");

    const [offsite] = occ("2024-03-04T00:00:00Z", "2024-03-08T00:00:00Z", "offsite@synthetic.example");
    assert.equal(offsite!.allDay, true);
    assert.equal(iso(offsite!.start), "2024-03-04T23:00:00.000Z");
    assert.equal(iso(offsite!.end), "2024-03-06T23:00:00.000Z");

    const [win] = occ("2024-03-04T00:00:00Z", "2024-03-08T00:00:00Z", "windows-tz@synthetic.example");
    assert.equal(iso(win!.start), "2024-03-05T09:00:00.000Z");
  });

  it("expands weekly BYDAY with EXDATE across a DST change", () => {
    const standups = occ("2024-03-11T00:00:00Z", "2024-03-15T00:00:00Z", "standup@synthetic.example");
    assert.deepEqual(standups.map((o) => iso(o.start)), ["2024-03-13T14:00:00.000Z"]);
  });

  it("replaces an instance overridden by RECURRENCE-ID", () => {
    const standups = occ("2024-03-04T00:00:00Z", "2024-03-08T00:00:00Z", "standup@synthetic.example");
    assert.deepEqual(
      standups.map((o) => [iso(o.start), o.event.summary]),
      [
        ["2024-03-04T15:00:00.000Z", "Standup"],
        ["2024-03-06T16:30:00.000Z", "Standup (moved)"],
      ],
    );
  });

  it("stops weekly rules at UNTIL and daily rules at COUNT", () => {
    assert.equal(occ("2024-04-01T00:00:00Z", "2024-04-08T00:00:00Z", "standup@synthetic.example").length, 0);
    const daily = occ("2024-03-04T00:00:00Z", "2024-03-10T00:00:00Z", "daily-count@synthetic.example");
    assert.deepEqual(daily.map((o) => iso(o.start)), ["2024-03-04T08:00:00.000Z", "2024-03-05T08:00:00.000Z"]);
  });

  it("expands long-running rules quickly and honours INTERVAL", () => {
    const ev: IcsEvent = {
      uid: "biweekly",
      start: { local: { y: 2015, m: 1, d: 5, hh: 9, mm: 0, ss: 0 }, tz: "UTC", allDay: false },
      durationMs: 3_600_000,
      attendees: [],
      exdates: [],
      rrule: { freq: "WEEKLY", interval: 2, wkst: 1 },
    };
    const out = expandEvents([ev], new Date("2024-03-01T00:00:00Z"), new Date("2024-03-31T00:00:00Z"));
    assert.deepEqual(out.map((o) => iso(o.start)), [
      "2024-03-04T09:00:00.000Z",
      "2024-03-18T09:00:00.000Z",
    ]);
  });

  it("filters daily rules by BYDAY", () => {
    const ev: IcsEvent = {
      uid: "weekdays",
      start: { local: { y: 2024, m: 3, d: 1, hh: 9, mm: 0, ss: 0 }, tz: "UTC", allDay: false },
      durationMs: 600_000,
      attendees: [],
      exdates: [],
      rrule: { freq: "DAILY", interval: 1, byday: [1, 2, 3, 4, 5], wkst: 1 },
    };
    const out = expandEvents([ev], new Date("2024-03-01T00:00:00Z"), new Date("2024-03-05T00:00:00Z"));
    assert.deepEqual(out.map((o) => iso(o.start).slice(0, 10)), ["2024-03-01", "2024-03-04"]);
  });
});
