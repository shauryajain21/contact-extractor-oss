/**
 * Strip credentials before anything leaves the machine. Chat transcripts in
 * particular are full of pasted keys.
 */

const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted:private-key]"],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g, "[redacted:api-key]"],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, "[redacted:github-token]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted:slack-token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted:aws-key]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[redacted:google-key]"],
  [/\bam_[a-z]{2}_[a-f0-9]{32,}\b/g, "[redacted:api-key]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted:jwt]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 [redacted]"],
  [
    /\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*)\s*[:=]\s*["']?[^\s"']{8,}["']?/g,
    "$1=[redacted]",
  ],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b(?=[^\n]{0,40}(?:key|token|secret))/gi, "[redacted:uuid-key]"],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…[truncated ${text.length - max} chars]`;
}

/** Redact then cap. Every source should pass bodies through this. */
export function clean(text: string, max: number): string {
  return truncate(redact(text).replace(/\r\n/g, "\n").trim(), max);
}
