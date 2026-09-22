/** Small RFC 5545 subset: enough for Google/Outlook/iCloud feeds. VTIMEZONE blocks are ignored; TZIDs go through Intl. */

export interface LocalDateTime {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
}

export interface IcsTime {
  local: LocalDateTime;
  /** IANA zone the wall-clock value is in; "UTC" for values ending in Z. */
  tz: string;
  allDay: boolean;
}

export interface IcsPerson {
  email?: string;
  name?: string;
  partstat?: string;
  cutype?: string;
  role?: string;
}

export interface RRule {
  freq: string;
  interval: number;
  count?: number;
  until?: IcsTime;
  /** 0 = Sunday … 6 = Saturday. */
  byday?: number[];
  wkst: number;
}

export interface IcsEvent {
  uid: string;
  summary?: string;
  description?: string;
  location?: string;
  url?: string;
  status?: string;
  start: IcsTime;
  end?: IcsTime;
  durationMs?: number;
  organizer?: IcsPerson;
  attendees: IcsPerson[];
  rrule?: RRule;
  exdates: IcsTime[];
  recurrenceId?: IcsTime;
}

export interface Occurrence {
  event: IcsEvent;
  start: Date;
  end: Date;
  allDay: boolean;
}

interface Property {
  name: string;
  params: Record<string, string>;
  value: string;
}

const DAY = 86_400_000;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const MAX_ITERATIONS = 20_000;

const WINDOWS_ZONES: Record<string, string> = {
  "pacific standard time": "America/Los_Angeles",
  "mountain standard time": "America/Denver",
  "central standard time": "America/Chicago",
  "eastern standard time": "America/New_York",
  "gmt standard time": "Europe/London",
  "greenwich standard time": "Atlantic/Reykjavik",
  "w. europe standard time": "Europe/Berlin",
  "romance standard time": "Europe/Paris",
  "central europe standard time": "Europe/Budapest",
  "central european standard time": "Europe/Warsaw",
  "e. europe standard time": "Europe/Bucharest",
  "india standard time": "Asia/Kolkata",
  "china standard time": "Asia/Shanghai",
  "tokyo standard time": "Asia/Tokyo",
  "singapore standard time": "Asia/Singapore",
  "aus eastern standard time": "Australia/Sydney",
  "utc": "UTC",
  "coordinated universal time": "UTC",
};

export function unfold(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .filter((l) => l.trim() !== "");
}

export function parseLine(line: string): Property | undefined {
  let inQuotes = false;
  let colon = -1;
  const semis: number[] = [];
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && c === ";") semis.push(i);
    else if (!inQuotes && c === ":") {
      colon = i;
      break;
    }
  }
  if (colon === -1) return undefined;
  const head = line.slice(0, colon);
  const cuts = [...semis, colon];
  const name = head.slice(0, cuts[0]).toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 0; i < semis.length; i++) {
    const part = line.slice(semis[i]! + 1, cuts[i + 1]);
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value: line.slice(colon + 1) };
}

export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

const zoneCache = new Map<string, boolean>();
export function isValidZone(tz: string): boolean {
  let ok = zoneCache.get(tz);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      ok = true;
    } catch {
      ok = false;
    }
    zoneCache.set(tz, ok);
  }
  return ok;
}

export function resolveZone(tzid: string, fallback: string): string {
  const raw = tzid.trim().replace(/^"|"$/g, "");
  if (isValidZone(raw)) return raw;
  const win = WINDOWS_ZONES[raw.toLowerCase()];
  if (win) return win;
  const segs = raw.split("/").filter(Boolean);
  for (const n of [3, 2]) {
    const tail = segs.slice(-n).join("/");
    if (segs.length >= n && isValidZone(tail)) return tail;
  }
  return fallback;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function localParts(utcMs: number, tz: string): LocalDateTime {
  if (tz === "UTC") {
    const d = new Date(utcMs);
    return {
      y: d.getUTCFullYear(),
      m: d.getUTCMonth() + 1,
      d: d.getUTCDate(),
      hh: d.getUTCHours(),
      mm: d.getUTCMinutes(),
      ss: d.getUTCSeconds(),
    };
  }
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return { y: p.year!, m: p.month!, d: p.day!, hh: p.hour! % 24, mm: p.minute!, ss: p.second! };
}

function offsetMs(utcMs: number, tz: string): number {
  const l = localParts(utcMs, tz);
  return Date.UTC(l.y, l.m - 1, l.d, l.hh, l.mm, l.ss) - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock time in `tz` to epoch ms. */
export function zonedToUtc(l: LocalDateTime, tz: string): number {
  const guess = Date.UTC(l.y, l.m - 1, l.d, l.hh, l.mm, l.ss);
  if (tz === "UTC") return guess;
  const first = offsetMs(guess, tz);
  const t = guess - first;
  const second = offsetMs(t, tz);
  return second === first ? t : guess - second;
}

export function toInstant(t: IcsTime): number {
  return zonedToUtc(t.allDay ? { ...t.local, hh: 0, mm: 0, ss: 0 } : t.local, t.tz);
}

export function parseIcsTime(value: string, params: Record<string, string>, defaultTz: string): IcsTime | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return undefined;
  const allDay = !m[4] || params.VALUE === "DATE";
  const tz = m[7] ? "UTC" : params.TZID ? resolveZone(params.TZID, defaultTz) : defaultTz;
  return {
    local: {
      y: Number(m[1]),
      m: Number(m[2]),
      d: Number(m[3]),
      hh: allDay ? 0 : Number(m[4]),
      mm: allDay ? 0 : Number(m[5]),
      ss: allDay ? 0 : Number(m[6] ?? 0),
    },
    tz: allDay ? defaultTz : tz,
    allDay,
  };
}

export function parseDuration(value: string): number | undefined {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return undefined;
  const [, sign, w, d, h, mi, s] = m;
  const ms = (Number(w ?? 0) * 7 + Number(d ?? 0)) * DAY + (Number(h ?? 0) * 3600 + Number(mi ?? 0) * 60 + Number(s ?? 0)) * 1000;
  return sign === "-" ? -ms : ms;
}

export function parseRRule(value: string, defaultTz: string): RRule | undefined {
  const parts: Record<string, string> = {};
  for (const kv of value.split(";")) {
    const eq = kv.indexOf("=");
    if (eq > 0) parts[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1);
  }
  if (!parts.FREQ) return undefined;
  const byday = parts.BYDAY?.split(",")
    .map((d) => WEEKDAYS.indexOf(d.trim().slice(-2).toUpperCase()))
    .filter((d) => d >= 0);
  const wkst = parts.WKST ? WEEKDAYS.indexOf(parts.WKST.toUpperCase()) : 1;
  return {
    freq: parts.FREQ.toUpperCase(),
    interval: Math.max(1, Number(parts.INTERVAL ?? 1) || 1),
    count: parts.COUNT ? Number(parts.COUNT) : undefined,
    until: parts.UNTIL ? parseIcsTime(parts.UNTIL, {}, defaultTz) : undefined,
    byday: byday?.length ? byday : undefined,
    wkst: wkst >= 0 ? wkst : 1,
  };
}

function parsePerson(p: Property): IcsPerson {
  const mailto = /^mailto:(.+)$/i.exec(p.value.trim());
  return {
    email: mailto ? mailto[1]!.trim().toLowerCase() : undefined,
    name: p.params.CN ? unescapeText(p.params.CN) : undefined,
    partstat: p.params.PARTSTAT?.toUpperCase(),
    cutype: p.params.CUTYPE?.toUpperCase(),
    role: p.params.ROLE?.toUpperCase(),
  };
}

function buildEvent(props: Property[], defaultTz: string): IcsEvent | undefined {
  const get = (n: string) => props.find((p) => p.name === n);
  const text = (n: string) => {
    const p = get(n);
    return p ? unescapeText(p.value) : undefined;
  };
  const dtstart = get("DTSTART");
  const start = dtstart && parseIcsTime(dtstart.value, dtstart.params, defaultTz);
  if (!start) return undefined;
  const dtend = get("DTEND");
  const rrule = get("RRULE");
  const recurrence = get("RECURRENCE-ID");
  const duration = get("DURATION");
  const exdates: IcsTime[] = [];
  for (const p of props.filter((x) => x.name === "EXDATE")) {
    for (const v of p.value.split(",")) {
      const t = parseIcsTime(v, p.params, defaultTz);
      if (t) exdates.push(t);
    }
  }
  const organizer = get("ORGANIZER");
  const summary = text("SUMMARY");
  return {
    uid: get("UID")?.value.trim() || `${summary ?? "event"}@${dtstart.value}`,
    summary,
    description: text("DESCRIPTION"),
    location: text("LOCATION"),
    url: get("URL")?.value.trim(),
    status: get("STATUS")?.value.trim().toUpperCase(),
    start,
    end: dtend ? parseIcsTime(dtend.value, dtend.params, defaultTz) : undefined,
    durationMs: duration ? parseDuration(duration.value) : undefined,
    organizer: organizer ? parsePerson(organizer) : undefined,
    attendees: props.filter((p) => p.name === "ATTENDEE").map(parsePerson),
    rrule: rrule ? parseRRule(rrule.value, defaultTz) : undefined,
    exdates,
    recurrenceId: recurrence ? parseIcsTime(recurrence.value, recurrence.params, defaultTz) : undefined,
  };
}

/** Floating times and all-day dates are read in `defaultTz`. */
export function parseIcs(text: string, defaultTz: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let props: Property[] | undefined;
  let nested = 0;
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (!p) continue;
    const value = p.value.trim().toUpperCase();
    if (p.name === "BEGIN") {
      if (value === "VEVENT" && !props) props = [];
      else if (props) nested++;
      continue;
    }
    if (p.name === "END") {
      if (props && nested > 0) nested--;
      else if (props && value === "VEVENT") {
        const ev = buildEvent(props, defaultTz);
        if (ev) events.push(ev);
        props = undefined;
      }
      continue;
    }
    if (props && nested === 0) props.push(p);
  }
  return events;
}

function dayNumber(l: { y: number; m: number; d: number }): number {
  return Math.floor(Date.UTC(l.y, l.m - 1, l.d) / DAY);
}

function fromDayNumber(n: number): { y: number; m: number; d: number } {
  const d = new Date(n * DAY);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function weekday(n: number): number {
  return (((n + 4) % 7) + 7) % 7;
}

function eventLength(ev: IcsEvent): { ms: number; days: number } {
  if (ev.end) {
    if (ev.start.allDay) {
      const days = Math.max(1, dayNumber(ev.end.local) - dayNumber(ev.start.local));
      return { ms: days * DAY, days };
    }
    return { ms: Math.max(0, toInstant(ev.end) - toInstant(ev.start)), days: 0 };
  }
  if (ev.durationMs !== undefined) {
    return ev.start.allDay
      ? { ms: ev.durationMs, days: Math.max(1, Math.round(ev.durationMs / DAY)) }
      : { ms: Math.max(0, ev.durationMs), days: 0 };
  }
  return ev.start.allDay ? { ms: DAY, days: 1 } : { ms: 0, days: 0 };
}

function occurrenceAt(ev: IcsEvent, local: LocalDateTime): Occurrence {
  const len = eventLength(ev);
  const start = zonedToUtc(local, ev.start.tz);
  const end = ev.start.allDay
    ? zonedToUtc({ ...fromDayNumber(dayNumber(local) + len.days), hh: 0, mm: 0, ss: 0 }, ev.start.tz)
    : start + len.ms;
  return { event: ev, start: new Date(start), end: new Date(end), allDay: ev.start.allDay };
}

/** Start wall-clock times of a DAILY/WEEKLY rule up to the window end; other FREQs yield only DTSTART. */
export function expandRule(ev: IcsEvent, since: Date, until: Date): LocalDateTime[] {
  const r = ev.rrule;
  const s = ev.start.local;
  if (!r || (r.freq !== "DAILY" && r.freq !== "WEEKLY")) return [s];
  const tz = ev.start.tz;
  const startDay = dayNumber(s);
  const endDay = dayNumber(localParts(until.getTime(), tz)) + 1;
  const untilMs = r.until ? toInstant(r.until) : Infinity;
  const periodDays = r.freq === "DAILY" ? r.interval : r.interval * 7;
  let skip = 0;
  if (r.count === undefined) {
    const sinceDay = dayNumber(localParts(since.getTime(), tz));
    const lenDays = Math.ceil(eventLength(ev).ms / DAY) + 1;
    skip = Math.max(0, Math.floor((sinceDay - startDay - lenDays) / periodDays) - 1);
  }

  const out: LocalDateTime[] = [];
  let count = 0;
  let iterations = 0;
  /** Returns false once the rule is exhausted. */
  const emit = (day: number): boolean => {
    const local = { ...fromDayNumber(day), hh: s.hh, mm: s.mm, ss: s.ss };
    const startMs = zonedToUtc(local, tz);
    if (startMs > untilMs) return false;
    count++;
    if (r.count !== undefined && count > r.count) return false;
    out.push(local);
    return true;
  };

  if (r.freq === "DAILY") {
    for (let k = skip; iterations++ < MAX_ITERATIONS; k++) {
      const day = startDay + k * r.interval;
      if (day > endDay) break;
      if (r.byday && !r.byday.includes(weekday(day))) continue;
      if (!emit(day)) break;
    }
    return out;
  }

  const days = r.byday ?? [weekday(startDay)];
  const offsets = [...new Set(days.map((wd) => (wd - r.wkst + 7) % 7))].sort((a, b) => a - b);
  const firstWeek = startDay - ((weekday(startDay) - r.wkst + 7) % 7);
  for (let k = skip; iterations++ < MAX_ITERATIONS; k++) {
    const weekStart = firstWeek + k * periodDays;
    if (weekStart > endDay) break;
    for (const off of offsets) {
      const day = weekStart + off;
      if (day < startDay) continue;
      if (!emit(day)) return out;
    }
  }
  return out;
}

function sameDate(a: LocalDateTime, b: LocalDateTime): boolean {
  return a.y === b.y && a.m === b.m && a.d === b.d;
}

/** Occurrences overlapping [since, until), with EXDATE and RECURRENCE-ID overrides applied. */
export function expandEvents(
  events: IcsEvent[],
  since: Date,
  until: Date,
  onError: (ev: IcsEvent, err: unknown) => void = () => {},
): Occurrence[] {
  const overridden = new Map<string, number[]>();
  for (const ev of events) {
    if (!ev.recurrenceId) continue;
    const list = overridden.get(ev.uid) ?? [];
    list.push(toInstant(ev.recurrenceId));
    overridden.set(ev.uid, list);
  }

  const overlaps = (o: Occurrence) =>
    o.end.getTime() > o.start.getTime()
      ? o.start < until && o.end > since
      : o.start >= since && o.start < until;

  const out: Occurrence[] = [];
  for (const ev of events) {
    try {
      if (ev.recurrenceId || !ev.rrule) {
        const o = occurrenceAt(ev, ev.start.local);
        if (overlaps(o)) out.push(o);
        continue;
      }
      const skipped = overridden.get(ev.uid) ?? [];
      for (const local of expandRule(ev, since, until)) {
        const o = occurrenceAt(ev, local);
        const excluded =
          skipped.includes(o.start.getTime()) ||
          ev.exdates.some((x) => (x.allDay ? sameDate(x.local, local) : toInstant(x) === o.start.getTime()));
        if (!excluded && overlaps(o)) out.push(o);
      }
    } catch (err) {
      onError(ev, err);
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}
