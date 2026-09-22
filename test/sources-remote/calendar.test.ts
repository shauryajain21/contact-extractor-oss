import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { defaultConfig } from "../../src/config.js";
import { cleanDescription, createCalendarSource, describeLocation, loadIcs } from "../../src/sources/calendar.js";
import type { CollectContext, Config, Logger } from "../../src/types.js";

const ICS_PATH = join(import.meta.dirname, "..", "fixtures", "remote", "calendar.ics");
const SECRET_URL = "https://calendar.example/calendar/ical/alex%40mycorp.example/private-0123456789abcdef/basic.ics";

function config(urls: string[]): Config {
  const c = defaultConfig();
  c.me = { name: "Alex Rivera", emails: ["alex@mycorp.example"], domains: ["mycorp.example"] };
  c.timezone = "Europe/Paris";
  c.sources.calendar = { enabled: true, icsUrls: urls };
  return c;
}

function recordingLog(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (msg: string, extra?: Record<string, unknown>) =>
    void lines.push(`${level} ${msg}${extra ? " " + JSON.stringify(extra) : ""}`);
  return { lines, debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") };
}

function ctx(c: Config, log: Logger = recordingLog()): CollectContext {
  return { config: c, log, since: new Date("2024-03-04T00:00:00Z"), until: new Date("2024-03-08T00:00:00Z") };
}

describe("calendarSource", () => {
  const ics = readFileSync(ICS_PATH, "utf8");

  it("emits one activity per occurrence, skipping cancelled and declined", async () => {
    const src = createCalendarSource(async () => ics);
    const acts = await src.collect(ctx(config([SECRET_URL])));
    assert.deepEqual(
      acts.map((a) => [a.at, a.title]),
      [
        ["2024-03-04T08:00:00.000Z", "Morning review"],
        ["2024-03-04T09:00:00.000Z", "Kickoff with Acme"],
        ["2024-03-04T14:00:00.000Z", "Partner sync (Paris)"],
        ["2024-03-04T15:00:00.000Z", "Standup"],
        ["2024-03-04T23:00:00.000Z", "Team offsite"],
        ["2024-03-05T08:00:00.000Z", "Morning review"],
        ["2024-03-05T09:00:00.000Z", "Outlook-exported meeting"],
        ["2024-03-06T16:30:00.000Z", "Standup (moved)"],
      ],
    );
    assert.ok(!acts.some((a) => a.title === "Cancelled lunch" || a.title === "Vendor pitch"));
  });

  it("builds text, participants and meta", async () => {
    const acts = await createCalendarSource(async () => ics).collect(ctx(config([SECRET_URL])));
    const kickoff = acts.find((a) => a.title === "Kickoff with Acme")!;
    assert.equal(kickoff.id, "calendar:utc-kickoff@synthetic.example:2024-03-04T09:00:00.000Z");
    assert.equal(kickoff.kind, "event");
    assert.equal(kickoff.fromMe, true);
    assert.equal(
      kickoff.text,
      [
        "When: 2024-03-04 10:00–10:30 (Europe/Paris)",
        "Where: Video call",
        "Organizer: Alex Rivera <alex@mycorp.example>",
        "Attendees: Doe: Jane <jane@acme.example> (accepted), Alex Rivera <alex@mycorp.example> (accepted)",
        "",
        "Agenda: review Q1 numbers and the partnership pipeline",
        "Second line, with comma",
      ].join("\n"),
    );
    assert.deepEqual(kickoff.participants, [
      { name: "Alex Rivera", email: "alex@mycorp.example", role: "from" },
      { name: "Doe: Jane", email: "jane@acme.example", role: "attendee" },
    ]);
    assert.deepEqual(kickoff.meta, {
      start: "2024-03-04T09:00:00.000Z",
      end: "2024-03-04T09:30:00.000Z",
      allDay: false,
      attendeeCount: 2,
      declined: false,
      recurring: false,
    });

    const paris = acts.find((a) => a.title === "Partner sync (Paris)")!;
    assert.equal(paris.fromMe, false);
    assert.ok(paris.text.endsWith("Notes\nBring the deck"), "Google Meet boilerplate and HTML removed");

    const offsite = acts.find((a) => a.title === "Team offsite")!;
    assert.ok(offsite.text.startsWith("When: 2024-03-05 – 2024-03-06 (all day)"));
    assert.equal(offsite.meta?.start, "2024-03-05");
    assert.equal(offsite.meta?.end, "2024-03-07");
    assert.equal(offsite.meta?.allDay, true);
  });

  it("dedupes events shared by two feeds and survives a failing feed without leaking its URL", async () => {
    const log = recordingLog();
    const src = createCalendarSource(async (loc) => {
      if (loc === "https://broken.example/secret-token/basic.ics") throw new Error("HTTP 404");
      return ics;
    });
    const c = config([SECRET_URL, "https://broken.example/secret-token/basic.ics", SECRET_URL]);
    const acts = await src.collect(ctx(c, log));
    assert.equal(acts.length, 8);
    const err = log.lines.find((l) => l.startsWith("error"));
    assert.ok(err?.includes("https://broken.example/…"));
    assert.ok(!log.lines.some((l) => l.includes("secret-token") || l.includes("private-0123")));
  });

  it("loads local files with the default loader", async () => {
    const acts = await createCalendarSource(loadIcs).collect(ctx(config([ICS_PATH])));
    assert.equal(acts.length, 8);
  });

  it("is enabled only with at least one feed", () => {
    const src = createCalendarSource(async () => "");
    assert.equal(src.enabled(config([])), false);
    assert.equal(src.enabled(config([ICS_PATH])), true);
  });
});

describe("calendar helpers", () => {
  it("describes URLs without secrets", () => {
    assert.equal(describeLocation(SECRET_URL), "https://calendar.example/…");
    assert.equal(describeLocation("webcal://cal.example/x/y.ics"), "https://cal.example/…");
    assert.equal(describeLocation("/tmp/cal.ics"), "/tmp/cal.ics");
  });

  it("cleans HTML descriptions", () => {
    assert.equal(cleanDescription("<p>Hi&nbsp;there</p><p>A &amp; B</p>"), "Hi there\nA & B");
  });
});
