import type { Source } from "../types.js";
import { calendarSource } from "./calendar.js";
import { claudeCodeSource } from "./claude-code.js";
import { cursorSource } from "./cursor.js";
import { gitSource } from "./git.js";
import { imapSource } from "./imap.js";
import { slackSource } from "./slack.js";

export const allSources: Source[] = [
  cursorSource,
  claudeCodeSource,
  gitSource,
  slackSource,
  imapSource,
  calendarSource,
];
