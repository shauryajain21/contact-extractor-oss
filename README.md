# worklog

I wanted a written record of my working day that I did not have to write.

`worklog` runs a few times a day on my laptop. It reads what I actually did — my Cursor
and Claude Code chats, my git commits, the Slack threads I was in, my mail, my calendar —
and writes it into my Obsidian vault:

- a **daily note**: what moved, what I did, what is still open, and who I talked to
- a **weekly rollup**
- one note per **person** and **company** I dealt with, with a dated timeline
- one note per **project**, with a progress log
- a **dashboard** listing every conversation where someone is waiting on me, and every one
  where I am waiting on them, oldest first

It never alters text I wrote myself. worklog edits only what sits between its own
`<!-- worklog:begin … -->` markers, and it reads a note before adding a line, so the same
item is never written twice.

## Motivation

I began with a simple question I could not answer: what did I do this week? The evidence
existed, but it was spread across five applications, and reconstructing it meant scrolling
through each one.

A second observation mattered more. The costliest thing I forgot was rarely a task. It was
a person — someone who emailed on Tuesday and was still waiting on Friday. I had built an
internal tool that extracted contacts from inbound mail, classified them, and tracked
whether anyone had replied. worklog is my attempt to generalise that tool: extract people
from every conversation the way a CRM would, classify them (customer, prospect,
partnership, vendor, hiring, spam), and record who owes the next reply.

## Quick start

```bash
npm install -g github:shauryajain21/contact-extractor-oss
worklog init                # asks who you are, where your vault is, which sources to read
worklog run --since 1d --dry-run   # see what it would write
worklog run --since 1d             # write it
worklog schedule install    # 8am, 12pm, 4pm, 8pm, with catch-up after sleep
```

Node 22 or newer is required.

## Sources

| Source | What it reads | Setup |
|---|---|---|
| Cursor | `~/.cursor/projects/*/agent-transcripts` | none |
| Claude Code | `~/.claude/projects/*.jsonl` | none |
| git | your commits in every repo under `sources.git.roots` | set `me.emails` |
| Slack | threads you wrote in or were mentioned in | user token (`xoxp-…`) in `SLACK_USER_TOKEN` |
| Email | IMAP, including Gmail with an app password | password in `IMAP_PASSWORD` |
| Calendar | any ICS feed, e.g. Google's secret iCal address | URL in `sources.calendar.icsUrls` |

All reading happens locally. Before any text leaves the machine, I strip secrets from it
(API keys, tokens, private keys). I added this after noticing how often my own coding-agent
transcripts contained a pasted key.

My first runs also counted my automations as my work: a scheduled agent opens a new chat
each time it fires, and each of those chats looked like a day's effort. worklog now treats
any chat that opens with the same long prompt as another chat in that project as
automated, and skips it. On one day of my own data this removed 6 of 15 Cursor chats. To
exclude more, add `ignorePatterns` (regexes matched against a chat's first prompt) under
`sources.cursor` or `sources.claudeCode`.

## Models

The extraction step supports:

- `openai` — or any OpenAI-compatible endpoint via `llm.baseUrl`
- `anthropic`
- `ollama` — fully local; nothing leaves the machine
- `none` — rule-based extraction only: projects from commits and chats, people from email
  and Slack headers, and reply tracking without summaries

With `none`, a project's progress line is the first prompt of each chat rather than a
summary. That is enough to see where the day went, but not to read it back a month later.

Keys are read from the environment variable named in `llm.apiKeyEnv`; the config file never
holds a secret.

Scheduled runs do not see variables exported in a shell profile. Put them in
`~/.config/worklog/.env` instead, one `NAME=value` per line, and `chmod 600` it:

```bash
OPENAI_API_KEY=sk-...
SLACK_USER_TOKEN=xoxp-...
IMAP_PASSWORD=your-app-password
```

Values already set in the environment take precedence. `worklog doctor` reports when a
scheduled job would be missing one.

## Configuration

`worklog init` writes `~/.config/worklog/config.json`. Every option is shown in
[`examples/config.example.json`](examples/config.example.json). The ones you are most likely
to change:

- `me.domains` — your work domains; people on them count as teammates, not contacts
- `filters.dropCategories` — defaults to `spam`, `newsletter`, `hiring`
- `filters.ignoreDomains` — senders to skip entirely, such as notification services
- `schedule.times` — when it runs, in the machine's local time

## Commands

```
worklog init       set up config and vault folders
worklog run        collect since the last run and write the vault
worklog status     last run, and who's waiting on whom
worklog doctor     check config, sources, keys and schedule
worklog schedule   install | uninstall | print
```

## Method

Each run follows the same procedure:

1. Take a lock, and define the window: from the end of the last successful run until now.
2. Collect activity from each enabled source in parallel.
3. Classify with fast rules first (newsletters, job applications, SEO pitches, teammates),
   then send the remainder to the model in batches.
4. Merge the result with the conversations already known, so that "waiting 3 days" stays
   accurate across runs.
5. Write the vault. The window advances only after every step succeeds. If a source fails,
   the next run repeats the same window, and deduplication makes the repeat safe.

Two design choices came from failures I observed in an earlier version of this job.
First, macOS `launchd` silently drops a scheduled slot that falls while the machine is
asleep; on my laptop, none of the first three slots fired on time. The installed schedule
therefore includes a catch-up job that checks every 30 minutes and runs once the last
success is older than the gap between slots plus 30 minutes. Second, when the network dropped mid-run, the agent retried for hours
instead of failing. Each run now stops after 15 minutes (`--timeout`) and leaves its window
for the next run.

State lives in `~/.local/state/worklog/`.

## Development

```bash
npm install
npm run verify     # typecheck + tests
npm run dev -- run --since 4h --dry-run
```

## License

MIT
