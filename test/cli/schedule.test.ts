import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../../src/config.js";
import {
  CATCHUP_LABEL,
  crontabLines,
  installSchedule,
  launchdPlists,
  programArgs,
  RUN_LABEL,
  systemdUnits,
  type ScheduleSpec,
} from "../../src/schedule.js";

function spec(over: Partial<ScheduleSpec> = {}): ScheduleSpec {
  return {
    program: ["/opt/node/bin/node", "/work/worklog/dist/cli.js"],
    configPath: "/Users/me/.config/worklog/config.json",
    config: { ...defaultConfig(), stateDir: "/Users/me/.local/state/worklog", schedule: { times: ["08:00", "12:30"] } },
    home: "/Users/me",
    ...over,
  };
}

test("launchd: a calendar agent and a catch-up agent", () => {
  const [run, catchup] = launchdPlists(spec());
  assert.equal(run!.path, "/Users/me/Library/LaunchAgents/dev.worklog.run.plist");
  assert.equal(catchup!.path, "/Users/me/Library/LaunchAgents/dev.worklog.catchup.plist");

  const r = run!.content;
  assert.ok(r.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist'));
  assert.match(r, new RegExp(`<key>Label</key>\\s*<string>${RUN_LABEL}</string>`));
  assert.match(
    r,
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/node\/bin\/node<\/string>\s*<string>\/work\/worklog\/dist\/cli.js<\/string>\s*<string>--config<\/string>\s*<string>\/Users\/me\/.config\/worklog\/config.json<\/string>\s*<string>run<\/string>\s*<\/array>/
  );
  assert.match(r, /<dict>\s*<key>Hour<\/key>\s*<integer>8<\/integer>\s*<key>Minute<\/key>\s*<integer>0<\/integer>\s*<\/dict>/);
  assert.match(r, /<key>Hour<\/key>\s*<integer>12<\/integer>\s*<key>Minute<\/key>\s*<integer>30<\/integer>/);
  assert.match(r, /<key>PATH<\/key>\s*<string>\/opt\/node\/bin:/);
  assert.match(r, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/me\/.local\/state\/worklog\/logs\/run.err.log<\/string>/);
  assert.ok(!r.includes("StartInterval"));

  const c = catchup!.content;
  assert.match(c, new RegExp(`<string>${CATCHUP_LABEL}</string>`));
  assert.match(c, /<key>StartInterval<\/key>\s*<integer>1800<\/integer>/);
  assert.match(c, /<string>run<\/string>\s*<string>--if-stale<\/string>/);
  assert.ok(!c.includes("StartCalendarInterval"));
  assert.equal(run!.secret, false);
});

test("launchd: XML special characters are escaped and passed env marks the file secret", () => {
  const [run] = launchdPlists(spec({ configPath: "/tmp/a&b <c>.json", env: { OPENAI_API_KEY: "sk-x" } }));
  assert.ok(run!.content.includes("<string>/tmp/a&amp;b &lt;c&gt;.json</string>"));
  assert.match(run!.content, /<key>OPENAI_API_KEY<\/key>\s*<string>sk-x<\/string>/);
  assert.equal(run!.secret, true);
});

test("systemd: persistent timer with one OnCalendar per time", () => {
  const [service, timer] = systemdUnits(spec({ home: "/home/me" }));
  assert.equal(service!.path, "/home/me/.config/systemd/user/worklog.service");
  assert.match(service!.content, /ExecStart=\/opt\/node\/bin\/node \/work\/worklog\/dist\/cli.js --config \S+ run\n/);
  assert.match(timer!.content, /OnCalendar=\*-\*-\* 08:00:00\nOnCalendar=\*-\*-\* 12:30:00\nPersistent=true/);
});

test("cron fallback includes a catch-up line", () => {
  const lines = crontabLines(spec());
  assert.ok(lines[0]!.startsWith("PATH="));
  assert.ok(lines.some((l) => l.startsWith("0 8 * * * /opt/node/bin/node")));
  assert.ok(lines.some((l) => l.startsWith("30 12 * * * ")));
  assert.ok(lines.some((l) => l.startsWith("*/30 * * * * ") && l.includes("run --if-stale")));
});

test("programArgs keeps tsx loaders with absolute paths", () => {
  const built = programArgs("/work/worklog/dist/cli.js", "/opt/node/bin/node", []);
  assert.deepEqual(built, ["/opt/node/bin/node", "/work/worklog/dist/cli.js"]);

  const dev = programArgs("/work/worklog/src/cli.ts", "/opt/node/bin/node", [
    "--require",
    "/x/tsx/dist/preflight.cjs",
    "--import",
    "file:///x/tsx/dist/loader.mjs",
  ]);
  assert.deepEqual(dev, [
    "/opt/node/bin/node",
    "--require",
    "/x/tsx/dist/preflight.cjs",
    "--import",
    "file:///x/tsx/dist/loader.mjs",
    "/work/worklog/src/cli.ts",
  ]);

  const bare = programArgs("/work/worklog/src/cli.ts", "/opt/node/bin/node", ["--import", "tsx"]);
  assert.equal(bare[1], "--import");
  assert.match(bare[2]!, /^file:\/\/.*node_modules\/tsx\//);

  const implicit = programArgs("/work/worklog/src/cli.ts", "/opt/node/bin/node", []);
  assert.equal(implicit[1], "--import");
  assert.match(implicit[2]!, /tsx/);
});

test("install on an unknown platform only prints crontab lines", () => {
  const out: string[] = [];
  const calls: string[] = [];
  const problems = installSchedule(
    spec({ config: { ...spec().config, stateDir: `${process.env.TMPDIR ?? "/tmp"}/worklog-sched-test` } }),
    { platform: "aix", exec: (c, a) => (calls.push([c, ...a].join(" ")), { status: 1, stdout: "", stderr: "" }), out: (l) => out.push(l) }
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(calls, []);
  assert.ok(out.some((l) => l.includes("run --if-stale")));
});
