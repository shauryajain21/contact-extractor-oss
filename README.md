# worklog

Your day, written down for you.

`worklog` runs a few times a day on your laptop. It reads what you actually did — your
Cursor and Claude Code chats, your git commits, the Slack threads you were in, your mail,
your calendar — and writes it into your Obsidian vault:

- a **daily note** with what moved, what you did, what's still open, and who you talked to
- a **weekly rollup**
- one note per **person** and **company** you dealt with, with a dated timeline
- one note per **project**, with a progress log
- a **dashboard** of every conversation where someone is waiting on you, and every one where
  you're waiting on them, oldest first

It never touches anything you wrote yourself. worklog only edits text between its own
`<!-- worklog:begin … -->` markers, and it checks your note before adding a line so the
same thing never shows up twice.

## Why

Most of us can't answer "what did I do this week?" without scrolling through five apps.
And the costliest thing to forget isn't a task — it's the person who emailed you on
Tuesday and is still waiting. worklog pulls the people out of your conversations the
way a CRM would, sorts them (customer, prospect, partnership, vendor, hiring, spam), and
keeps track of who owes the next reply.

## Quick start

```bash
npm install -g github:shauryajain21/contact-extractor-oss
worklog init                # asks who you are, where your vault is, which sources to read
worklog run --since 1d --dry-run   # see what it would write
worklog run --since 1d             # write it
worklog schedule install    # 8am, 12pm, 4pm, 8pm, with catch-up after sleep
```

Needs Node 22 or newer.

## Sources

| Source | What it reads | Setup |
|---|---|---|
| Cursor | `~/.cursor/projects/*/agent-transcripts` | none |
| Claude Code | `~/.claude/projects/*.jsonl` | none |
| git | your commits in every repo under `sources.git.roots` | set `me.emails` |
| Slack | threads you wrote in or were mentioned in | user token (`xoxp-…`) in `SLACK_USER_TOKEN` |
| Email | IMAP, including Gmail with an app password | password in `IMAP_PASSWORD` |
| Calendar | any ICS feed, e.g. Google's secret iCal address | URL in `sources.calendar.icsUrls` |

Everything is read locally. Secrets (API keys, tokens, private keys) are stripped from
text before it's sent anywhere.

Chats started by a scheduled agent rather than by you — anything that opens with the same
long prompt as another chat in that project — are skipped, so an automation's runs don't
show up as your work. Add `ignorePatterns` (regexes on a chat's first prompt) under
`sources.cursor` or `sources.claudeCode` to skip more.

## Models

The extraction step works with any of:

- `openai` — or any OpenAI-compatible endpoint via `llm.baseUrl`
- `anthropic`
- `ollama` — fully local, nothing leaves your machine
- `none` — rule-based extraction only: projects from commits and chats, people from
  email and Slack headers, and reply tracking without summaries

Keys are read from the environment variable named in `llm.apiKeyEnv`; the config file
never holds a secret.

Scheduled runs don't see variables exported in your shell profile. Put them in
`~/.config/worklog/.env` instead, one `NAME=value` per line, and `chmod 600` it:

```bash
OPENAI_API_KEY=sk-...
SLACK_USER_TOKEN=xoxp-...
IMAP_PASSWORD=your-app-password
```

Values already set in the environment take precedence. `worklog doctor` tells you when
a scheduled job would be missing one.

## Configuration

`worklog init` writes `~/.config/worklog/config.json`. See
[`examples/config.example.json`](examples/config.example.json) for every option. The
ones you'll likely touch:

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

## How a run works

1. Take a lock, and work out the window: from the last successful run until now.
2. Pull activity from each enabled source in parallel.
3. Classify with fast rules first (newsletters, job applications, SEO pitches, teammates),
   then send what's left to the model in batches.
4. Merge the result with the conversations worklog already knew about, so "waiting 3 days"
   stays accurate across runs.
5. Write the vault. Only after everything succeeds does the window move forward; if a source
   fails, the next run picks up the same window again, and the dedup makes that safe.

State lives in `~/.local/state/worklog/`.

## Development

```bash
npm install
npm run verify     # typecheck + tests
npm run dev -- run --since 4h --dry-run
```

## License

MIT
