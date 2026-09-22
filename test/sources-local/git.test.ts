import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { commitUrl, findRepos, gitSource, parseGitLog, remoteWebBase } from "../../src/sources/git.js";
import { ctx, FAKE_KEY, recordingLogger, removeTempDirs, tempDir, testConfig } from "./helpers.js";

after(removeTempDirs);

const ME = "me@example.com";
const OTHER = "someone@example.org";

function g(repo: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
}

function commit(repo: string, email: string, name: string, date: string, message: string[]): string {
  const env = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const msgArgs = message.flatMap((m) => ["-m", m]);
  g(repo, ["-c", `user.email=${email}`, "-c", `user.name=${name}`, "commit", "-q", "--allow-empty", ...msgArgs], env);
  return g(repo, ["rev-parse", "HEAD"]).trim();
}

function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  g(dir, ["init", "-q", "-b", "main"]);
  return dir;
}

describe("git remote URL conversion", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  it("converts GitHub and GitLab SSH and HTTPS remotes", () => {
    assert.equal(commitUrl("git@github.com:acme/widgets.git", sha), `https://github.com/acme/widgets/commit/${sha}`);
    assert.equal(commitUrl("ssh://git@github.com/acme/widgets.git", sha), `https://github.com/acme/widgets/commit/${sha}`);
    assert.equal(commitUrl("https://github.com/acme/widgets.git", sha), `https://github.com/acme/widgets/commit/${sha}`);
    assert.equal(commitUrl("https://user@github.com/acme/widgets", sha), `https://github.com/acme/widgets/commit/${sha}`);
    assert.equal(commitUrl("git@gitlab.com:group/sub/proj.git", sha), `https://gitlab.com/group/sub/proj/commit/${sha}`);
    assert.equal(commitUrl("ssh://git@gitlab.example.com:2222/team/proj.git", sha), `https://gitlab.example.com/team/proj/commit/${sha}`);
  });

  it("ignores unknown hosts, local paths and empty remotes", () => {
    assert.equal(remoteWebBase("git@bitbucket.org:acme/widgets.git"), undefined);
    assert.equal(remoteWebBase("/srv/git/widgets.git"), undefined);
    assert.equal(commitUrl(undefined, sha), undefined);
    assert.equal(commitUrl("", sha), undefined);
  });
});

describe("parseGitLog", () => {
  it("splits records and keeps multi-line bodies", () => {
    const out = parseGitLog(
      "\x1eabc\x1f2026-09-04T10:00:00-04:00\x1fMe\x1fme@example.com\x1fSubject one\x1fLine 1\nLine 2\n\n" +
        "\x1edef\x1f2026-09-04T11:00:00-04:00\x1fMe\x1fme@example.com\x1fSubject two\x1f\n",
    );
    assert.equal(out.length, 2);
    assert.equal(out[0]?.body, "Line 1\nLine 2");
    assert.equal(out[1]?.subject, "Subject two");
    assert.equal(out[1]?.body, "");
  });
});

describe("gitSource", () => {
  let root: string;
  let shas: Record<"old" | "mine" | "other" | "byName" | "late" | "branch", string>;

  before(() => {
    root = tempDir("worklog-git-");
    const repo = initRepo(join(root, "group", "widgets"));
    g(repo, ["remote", "add", "origin", "git@github.com:acme/widgets.git"]);
    const old = commit(repo, ME, "Me", "2026-09-01T12:00:00Z", ["Old work"]);
    const mine = commit(repo, ME, "Me", "2026-09-04T16:30:00Z", ["Add billing webhook", `Uses ${FAKE_KEY} for now`]);
    const other = commit(repo, OTHER, "Someone Else", "2026-09-04T16:45:00Z", ["Their change"]);
    const byName = commit(repo, "me@personal.example", "Jane Handle", "2026-09-04T17:00:00Z", ["Commit under alias"]);
    const late = commit(repo, ME, "Me", "2026-09-04T19:00:00Z", ["After the window"]);
    g(repo, ["checkout", "-q", "-b", "feature", old]);
    const branch = commit(repo, ME.toUpperCase(), "Me", "2026-09-04T17:15:00Z", ["Feature branch work"]);
    shas = { old, mine, other, byName, late, branch };

    initRepo(join(root, "solo"));
    commit(join(root, "solo"), ME, "Me", "2026-09-04T16:10:00Z", ["Solo repo commit"]);

    const nm = initRepo(join(root, "node_modules", "dep"));
    commit(nm, ME, "Me", "2026-09-04T16:20:00Z", ["Should be skipped: node_modules"]);
    const nested = initRepo(join(root, "solo", "nested"));
    commit(nested, ME, "Me", "2026-09-04T16:20:00Z", ["Should be skipped: nested repo"]);
    initRepo(join(root, "a", "b", "too-deep"));
    writeFileSync(join(root, "README.txt"), "not a repo");
  });

  it("finds repos up to maxDepth without descending into repos, node_modules or dot-dirs", async () => {
    const repos = (await findRepos(root, 2)).map((r) => r.slice(root.length + 1)).sort();
    assert.deepEqual(repos, ["group/widgets", "solo"]);
  });

  it("returns only the configured author's commits inside the window, across branches", async () => {
    const config = testConfig((c) => {
      c.sources.git.roots = [root];
      c.sources.git.maxDepth = 2;
      c.me.emails = [ME];
      c.me.gitAuthors = ["jane handle"];
    });
    const out = await gitSource.collect(ctx(config, "2026-09-04T16:00:00Z", "2026-09-04T18:00:00Z"));
    const titles = out.map((a) => a.title).sort();
    assert.deepEqual(titles, ["Add billing webhook", "Commit under alias", "Feature branch work", "Solo repo commit"]);
    assert.equal(new Set(out.map((a) => a.id)).size, out.length);

    const mine = out.find((a) => a.title === "Add billing webhook");
    assert.ok(mine);
    assert.equal(mine.id, `git:widgets:${shas.mine}`);
    assert.equal(mine.kind, "commit");
    assert.equal(mine.source, "git");
    assert.equal(mine.fromMe, true);
    assert.equal(mine.project, "widgets");
    assert.equal(mine.threadId, "git:widgets");
    assert.equal(mine.at, "2026-09-04T16:30:00.000Z");
    assert.equal(mine.url, `https://github.com/acme/widgets/commit/${shas.mine}`);
    assert.match(mine.text, /^Add billing webhook\n\nUses \[redacted:api-key\] for now$/);
    assert.ok(!mine.text.includes(FAKE_KEY));

    const solo = out.find((a) => a.project === "solo");
    assert.equal(solo?.url, undefined);
  });

  it("includes nothing and warns once when no author identity is configured", async () => {
    const log = recordingLogger();
    const config = testConfig((c) => {
      c.sources.git.roots = [root];
    });
    const out = await gitSource.collect(ctx(config, "2026-09-04T16:00:00Z", "2026-09-04T18:00:00Z", log));
    assert.deepEqual(out, []);
    assert.equal(log.warnings.length, 1);
  });

  it("is disabled when no root exists", () => {
    const config = testConfig((c) => {
      c.sources.git.roots = ["/definitely/not/here"];
    });
    assert.equal(gitSource.enabled(config), false);
  });
});
