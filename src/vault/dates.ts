const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** `YYYY-MM-DD` of the instant in `timeZone`. */
export function localDate(date: Date | string, timeZone: string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "";
  const p = zonedParts(d, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** `YYYY-MM-DD HH:mm` in `timeZone`. */
export function localDateTime(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${localDate(date, timeZone)} ${pad(p.hour)}:${pad(p.minute)}`;
}

function ymdToUtc(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function utcToYmd(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDays(ymd: string, days: number): string {
  return utcToYmd(ymdToUtc(ymd) + days * DAY_MS);
}

/** Whole calendar days from `from` to `to` (both `YYYY-MM-DD`). */
export function daysBetween(from: string, to: string): number {
  return Math.round((ymdToUtc(to) - ymdToUtc(from)) / DAY_MS);
}

/** ISO-8601 week: weeks start Monday, week 1 contains the year's first Thursday. */
export function isoWeek(ymd: string): { year: number; week: number } {
  const ms = ymdToUtc(ymd);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7;
  const thursday = ms + (3 - weekday) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1;
  return { year, week };
}

/** `YYYY-Www`. */
export function isoWeekName(ymd: string): string {
  const { year, week } = isoWeek(ymd);
  return `${pad(year, 4)}-W${pad(week)}`;
}

/** Monday of the ISO week containing `ymd`. */
export function isoWeekStart(ymd: string): string {
  const weekday = (new Date(ymdToUtc(ymd)).getUTCDay() + 6) % 7;
  return addDays(ymd, -weekday);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
