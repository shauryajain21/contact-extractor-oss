/**
 * Text surgery for notes the user also edits. Every helper returns a new
 * string that differs from the input only inside worklog's own blocks, or by
 * an insertion; nothing outside is ever rewritten.
 */

const BEGIN = (key: string) => `<!-- worklog:begin ${key} -->`;
const END = (key: string) => `<!-- worklog:end ${key} -->`;

export interface Block {
  /** Offset of the begin marker. */
  start: number;
  /** Offset just past the end marker. */
  end: number;
  innerStart: number;
  innerEnd: number;
  /** Lines between the markers, without the trailing newline. */
  inner: string;
}

function lineEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function findBlock(text: string, key: string): Block | null {
  const begin = BEGIN(key);
  const start = text.indexOf(begin);
  if (start === -1) return null;
  const afterBegin = text.indexOf("\n", start);
  if (afterBegin === -1) return null;
  const innerStart = afterBegin + 1;
  const endMarker = text.indexOf(END(key), innerStart - 1);
  if (endMarker === -1) return null;
  const innerEnd = endMarker;
  let inner = text.slice(innerStart, innerEnd);
  inner = inner.replace(/\r?\n$/, "");
  return { start, end: endMarker + END(key).length, innerStart, innerEnd, inner };
}

export function renderBlock(key: string, inner: string, eol = "\n"): string {
  const body = inner.trim() === "" ? "" : inner.replace(/\r?\n/g, eol) + eol;
  return `${BEGIN(key)}${eol}${body}${END(key)}`;
}

/** Replace a block's contents. Returns null when the block is absent. */
export function replaceBlock(text: string, key: string, inner: string): string | null {
  const b = findBlock(text, key);
  if (!b) return null;
  const eol = lineEol(text);
  const body = inner.trim() === "" ? "" : inner.replace(/\r?\n/g, eol) + eol;
  return text.slice(0, b.innerStart) + body + text.slice(b.innerEnd);
}

/** Replace the block, or append it at the end of the note. */
export function upsertBlock(text: string, key: string, inner: string): string {
  return replaceBlock(text, key, inner) ?? appendAtEnd(text, renderBlock(key, inner, lineEol(text)));
}

export function blockLines(text: string, key: string): string[] {
  const b = findBlock(text, key);
  if (!b || b.inner === "") return [];
  return b.inner.split(/\r?\n/);
}

function appendAtEnd(text: string, chunk: string): string {
  const eol = lineEol(text);
  if (text === "") return chunk + eol;
  const sep = text.endsWith(eol + eol) ? "" : text.endsWith(eol) ? eol : eol + eol;
  return text + sep + chunk + eol;
}

interface Heading {
  level: number;
  /** Offset of the heading line. */
  start: number;
  /** Offset where the section ends (next heading of same or higher level, or EOF). */
  sectionEnd: number;
}

function headingLevel(line: string): number {
  const m = /^(#{1,6})\s/.exec(line);
  return m ? m[1]!.length : 0;
}

function findHeading(text: string, heading: string): Heading | null {
  const want = heading.trim();
  const level = headingLevel(want);
  let offset = 0;
  let inFence = false;
  let found: Heading | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence) {
      const l = headingLevel(line);
      if (found && l > 0 && l <= found.level) {
        found.sectionEnd = offset;
        return found;
      }
      if (!found && l === level && line.trim() === want) {
        found = { level, start: offset, sectionEnd: text.length };
      }
    }
    offset += raw.length + 1;
  }
  return found;
}

/** Append the heading at the end of the note if no line matches it exactly. */
export function ensureHeading(text: string, heading: string): string {
  if (findHeading(text, heading)) return text;
  return appendAtEnd(text, heading.trim());
}

/**
 * Append lines to the managed block `key` under `heading`. The block is
 * created at the end of that section (after its last non-blank line) the
 * first time; the heading is created if missing.
 */
export function appendUnderHeading(text: string, heading: string, key: string, lines: string[]): string {
  if (lines.length === 0) return text;
  const eol = lineEol(text);
  const existing = findBlock(text, key);
  if (existing) {
    const inner = existing.inner === "" ? lines.join(eol) : existing.inner + eol + lines.join(eol);
    return replaceBlock(text, key, inner)!;
  }
  const withHeading = ensureHeading(text, heading);
  const h = findHeading(withHeading, heading)!;
  const section = withHeading.slice(h.start, h.sectionEnd);
  const trimmedLen = section.replace(/\s+$/, "").length;
  const insertAt = h.start + trimmedLen;
  const block = renderBlock(key, lines.join(eol), eol);
  const before = withHeading.slice(0, insertAt);
  const after = withHeading.slice(insertAt);
  const tail =
    after === ""
      ? eol
      : /^\s*$/.test(after) || after.startsWith(eol + eol)
        ? ""
        : after.startsWith(eol)
          ? eol
          : eol + eol;
  return before + eol + block + tail + after;
}

// ---------- frontmatter ----------

export type FrontmatterValue = string | number | boolean | string[];

function splitFrontmatter(text: string): { lines: string[]; bodyStart: number } | null {
  if (!/^---\r?\n/.test(text)) return null;
  const firstEol = text.indexOf("\n") + 1;
  const close = /^---[ \t]*\r?$/m;
  const rest = text.slice(firstEol);
  const m = close.exec(rest);
  if (!m) return null;
  const fm = rest.slice(0, m.index);
  const afterClose = firstEol + m.index + m[0].length;
  const bodyStart = text[afterClose] === "\n" ? afterClose + 1 : afterClose;
  return { lines: fm === "" ? [] : fm.replace(/\r?\n$/, "").split(/\r?\n/), bodyStart };
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\"/g, '"');
  }
  return t;
}

function parseList(v: string): string[] {
  const t = v.trim();
  if (t.startsWith("[") && t.endsWith("]")) {
    return t
      .slice(1, -1)
      .split(",")
      .map((s) => unquote(s))
      .filter(Boolean);
  }
  return t ? [unquote(t)] : [];
}

/** Top-level scalar and list keys only; enough to read back worklog's own keys. */
export function readFrontmatter(text: string): Record<string, string | string[]> {
  const fm = splitFrontmatter(text);
  const out: Record<string, string | string[]> = {};
  if (!fm) return out;
  let listKey: string | null = null;
  for (const line of fm.lines) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const cur = out[listKey];
      out[listKey] = [...(Array.isArray(cur) ? cur : []), unquote(item[1]!)];
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) {
      listKey = null;
      continue;
    }
    const [, key, value] = kv as unknown as [string, string, string];
    if (value.trim() === "") {
      out[key] = [];
      listKey = key;
    } else {
      out[key] = value.trim().startsWith("[") ? parseList(value) : unquote(value);
      listKey = null;
    }
  }
  return out;
}

function yamlScalar(v: string | number | boolean): string {
  if (typeof v !== "string") return String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  if (v === "" || /^[\s>|!&*%@`{}[\],#?'"-]|: |\s#|^(true|false|null|yes|no|~)$|^[\d.+-]+$|\s$/i.test(v)) {
    return JSON.stringify(v);
  }
  return v;
}

function yamlValue(v: FrontmatterValue): string {
  return Array.isArray(v) ? `[${v.map(yamlScalar).join(", ")}]` : yamlScalar(v);
}

/** Index range [from, to) of a top-level key including its indented continuation lines. */
function keyRange(lines: string[], key: string): [number, number] | null {
  const idx = lines.findIndex((l) => new RegExp(`^${key.replace(/[-]/g, "\\-")}:(\\s|$)`).test(l));
  if (idx === -1) return null;
  let to = idx + 1;
  while (to < lines.length && /^(\s+\S|\s*$)/.test(lines[to]!) && lines[to]!.trim() !== "") to++;
  return [idx, to];
}

/**
 * Set worklog-owned keys (undefined values are skipped) and make sure each of
 * `addTags` is in `tags`, leaving every other key and tag untouched. Creates
 * the frontmatter when the note has none.
 */
export function mergeFrontmatter(
  text: string,
  set: Record<string, FrontmatterValue | undefined>,
  addTags: string[] = []
): string {
  const eol = lineEol(text);
  const fm = splitFrontmatter(text);
  const lines = fm ? [...fm.lines] : [];
  const body = fm ? text.slice(fm.bodyStart) : text;

  for (const [key, value] of Object.entries(set)) {
    if (value === undefined || value === "") continue;
    const line = `${key}: ${yamlValue(value)}`;
    const range = keyRange(lines, key);
    if (range) {
      const current = lines.slice(range[0], range[1]);
      if (current.length === 1 && current[0] === line) continue;
      lines.splice(range[0], range[1] - range[0], line);
    } else {
      lines.push(line);
    }
  }

  if (addTags.length) {
    const current = readFrontmatter(["---", ...lines, "---", ""].join("\n")).tags;
    const have = Array.isArray(current) ? current : current ? parseList(current) : [];
    const missing = addTags.filter((t) => !have.includes(t));
    if (missing.length) {
      const range = keyRange(lines, "tags");
      if (!range) {
        lines.push(`tags: ${yamlValue(missing)}`);
      } else if (range[1] - range[0] > 1 || /^tags:\s*$/.test(lines[range[0]]!)) {
        const indent = /^(\s+)-/.exec(lines[range[0] + 1] ?? "")?.[1] ?? "  ";
        lines.splice(range[1], 0, ...missing.map((t) => `${indent}- ${yamlScalar(t)}`));
      } else {
        lines.splice(range[0], 1, `tags: ${yamlValue([...have, ...missing])}`);
      }
    }
  }

  if (fm ? lines.join("\n") === fm.lines.join("\n") : lines.length === 0) return text;
  return ["---", ...lines, "---"].join(eol) + eol + body;
}

// ---------- text utilities ----------

/** Lowercased, links reduced to their label, punctuation and list markers removed. */
export function normalizeLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A usable note filename: no path or link syntax characters, single spaces, at most 120 chars. */
export function sanitizeNoteName(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|#^[\]]/g, " ")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  const capped = cleaned.length > 120 ? cleaned.slice(0, 120).trim() : cleaned;
  return capped || "Untitled";
}

export function wikiLink(name: string): string {
  return `[[${sanitizeNoteName(name)}]]`;
}

/** Collapse to one terse line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function escapeCell(text: string): string {
  return oneLine(text).replace(/\|/g, "\\|");
}
