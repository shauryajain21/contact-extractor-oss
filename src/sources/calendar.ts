import { readFile } from "node:fs/promises";
import { expandHome } from "../config.js";
import { clean } from "../redact.js";
import type { Activity, CollectContext, Config, Participant, Source } from "../types.js";
import { expandEvents, localParts, parseIcs, type IcsPerson, type Occurrence } from "./ics.js";

export type IcsLoader = (location: string) => Promise<string>;

export const loadIcs: IcsLoader = async (location) => {
  const loc = location.replace(/^webcal:\/\//i, "https://");
  if (/^https?:\/\//i.test(loc)) {
    const res = await fetch(loc, { headers: { Accept: "text/calendar" }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }
  return readFile(expandHome(loc.replace(/^file:\/\//i, "")), "utf8");
};

/** Secret ICS addresses embed a private token, so logs only get the host. */
export function describeLocation(location: string): string {
  try {
    const u = new URL(location.replace(/^webcal:\/\//i, "https://"));
    if (u.protocol === "https:" || u.protocol === "http:") return `${u.protocol}//${u.host}/…`;
  } catch {
    // not a URL
  }
  return location;
}

function isRoom(p: IcsPerson): boolean {
  return p.cutype === "ROOM" || p.cutype === "RESOURCE" || /@resource\.calendar\.google\.com$/.test(p.email ?? "");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function localDate(ms: number, tz: string): string {
  const l = localParts(ms, tz);
  return `${l.y}-${pad(l.m)}-${pad(l.d)}`;
}

function localTime(ms: number, tz: string): string {
  const l = localParts(ms, tz);
  return `${pad(l.hh)}:${pad(l.mm)}`;
}

export function formatRange(o: Occurrence, tz: string): string {
  const s = o.start.getTime();
  const e = o.end.getTime();
  if (o.allDay) {
    const lastDay = localDate(e - 1, tz);
    const first = localDate(s, tz);
    return lastDay > first ? `${first} – ${lastDay} (all day)` : `${first} (all day)`;
  }
  const day = localDate(s, tz);
  if (e <= s) return `${day} ${localTime(s, tz)} (${tz})`;
  const endDay = localDate(e, tz);
  const end = endDay === day ? localTime(e, tz) : `${endDay} ${localTime(e, tz)}`;
  return `${day} ${localTime(s, tz)}–${end} (${tz})`;
}

/** Calendar invites carry HTML and Google Meet boilerplate that is noise for the extractor. */
export function cleanDescription(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(/-::~[:~]*::-[\s\S]*?(?:-::~[:~]*::-|$)/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatPerson(p: IcsPerson): string {
  const who = p.name && p.email ? `${p.name} <${p.email}>` : (p.name ?? p.email ?? "(unknown)");
  return p.partstat ? `${who} (${p.partstat.toLowerCase()})` : who;
}

export function occurrenceToActivity(o: Occurrence, config: Config): Activity | undefined {
  const ev = o.event;
  const mine = new Set(config.me.emails.map((e) => e.toLowerCase()));
  const isMe = (p: IcsPerson | undefined) => !!p?.email && mine.has(p.email);
  if (ev.status === "CANCELLED") return undefined;
  const declined = ev.attendees.some((a) => isMe(a) && a.partstat === "DECLINED");
  if (declined) return undefined;

  const tz = config.timezone;
  const people = ev.attendees.filter((a) => !isRoom(a));
  const participants: Participant[] = [];
  const seen = new Set<string>();
  const add = (p: IcsPerson, role: Participant["role"]) => {
    const key = (p.email ?? p.name ?? "").toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    participants.push({ name: p.name, email: p.email, role });
  };
  if (ev.organizer) add(ev.organizer, "from");
  people.forEach((a) => add(a, "attendee"));

  const lines = [`When: ${formatRange(o, tz)}`];
  if (ev.location) lines.push(`Where: ${ev.location}`);
  if (ev.organizer) lines.push(`Organizer: ${formatPerson({ ...ev.organizer, partstat: undefined })}`);
  if (people.length) lines.push(`Attendees: ${people.map(formatPerson).join(", ")}`);
  const description = cleanDescription(ev.description);
  if (description) lines.push("", description);

  const start = o.start.toISOString();
  return {
    id: `calendar:${ev.uid}:${start}`,
    source: "calendar",
    kind: "event",
    at: start,
    title: ev.summary ? clean(ev.summary, 200) : "(no title)",
    text: clean(lines.join("\n"), config.limits.maxActivityChars),
    url: ev.url,
    participants,
    fromMe: isMe(ev.organizer),
    meta: {
      start: o.allDay ? localDate(o.start.getTime(), tz) : start,
      end: o.allDay ? localDate(o.end.getTime(), tz) : o.end.toISOString(),
      allDay: o.allDay,
      attendeeCount: people.length,
      declined,
      recurring: !!ev.rrule || !!ev.recurrenceId,
    },
  };
}

export function createCalendarSource(load: IcsLoader = loadIcs): Source {
  return {
    name: "calendar",
    enabled(config) {
      return config.sources.calendar.enabled && config.sources.calendar.icsUrls.length > 0;
    },
    async collect(ctx: CollectContext): Promise<Activity[]> {
      const { config, log, since, until } = ctx;
      const byId = new Map<string, Activity>();
      for (const location of config.sources.calendar.icsUrls) {
        const where = describeLocation(location);
        let occurrences: Occurrence[];
        try {
          const text = await load(location);
          occurrences = expandEvents(parseIcs(text, config.timezone), since, until, (ev, err) =>
            log.warn(`calendar: skipping event in ${where}`, { uid: ev.uid, error: String(err) }),
          );
        } catch (err) {
          log.error(`calendar: could not read ${where}`, { error: String(err) });
          continue;
        }
        for (const o of occurrences) {
          try {
            const a = occurrenceToActivity(o, config);
            if (a && !byId.has(a.id)) byId.set(a.id, a);
          } catch (err) {
            log.warn(`calendar: skipping event in ${where}`, { uid: o.event.uid, error: String(err) });
          }
        }
      }
      const out = [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
      log.info(`calendar: ${out.length} events`);
      return out;
    },
  };
}

export const calendarSource: Source = createCalendarSource();
