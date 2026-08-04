# tenken

**One command for agent config.** `tenken` (点検 — "inspection") runs three linters over your
repository in a single pass and gives you one report, one exit code and one GitHub Action.

```
npx @hyuga/tenken
```

```
✗ AGENTS.md — 2 problems
    [reflint]     AGENTS.md:7   `npm run build:docs` — no script "build:docs" in package.json
    [carrylint]   AGENTS.md:13  author-specific absolute path `/Users/hana/dev/app` — …
✗ .claude/skills/report/SKILL.md — 1 problem
    [skills-lint] .claude/skills/report/SKILL.md:1  name "Report_Skill" does not match its directory "report"

tenken: 3 problems (3 errors, 0 warnings) — reflint 1, skills-lint 1, carrylint 1
```

## Why

The three linters were built separately and overlap on the files they read:

| | `AGENTS.md` | `CLAUDE.md` | `llms.txt` | `SKILL.md` | `.claude/commands/…` |
|---|---|---|---|---|---|
| [reflint](https://github.com/hyuga611/reflint) — references resolve | ● | ● | ● | | |
| [skills-lint](https://github.com/hyuga611/skills-lint) — skill schema, trigger collisions | | | | ● | |
| [carrylint](https://github.com/hyuga611/carrylint) — runs on someone else's machine | ● | ● | | ● | ● |

Installing all three meant three packages, three CI steps, three configurations and three walks
of the same tree. `tenken` is the single door: it discovers files once and calls the three
linters' exported checks. It has no rules of its own — the linters stay the source of truth, and
each remains independently useful.

## Tried on real code

Not on fixtures. On the two biggest public bodies of agent config that exist, in August 2026.

**The 46 skills bundled in [openclaw/openclaw](https://github.com/openclaw/openclaw)** (385k stars).
13 genuine defects in 6 skills — including `/Users/steipete/openclaw` hardcoded into a shipped
first-party skill, a skill instructing the agent to read `../openclaw-docs/SKILL.md` when no such
skill exists, and four dangling test-fixture paths.

**A random sample of 2,465 skills published on [ClawHub](https://clawhub.ai)** (drawn from 69,265
enumerated, seed `20260804`):

| | |
|---|---|
| declared `name` differs from the registry slug | **29.2%** |
| `SKILL.md` ships with no YAML frontmatter at all — nothing for the agent to match on | **7.1%** |
| an absolute path that resolves only on the author's machine | **3.8%** |

The same run was also the harshest test of the linters themselves: on the openclaw corpus the
tools first reported **201 errors for 13 real defects**. Five precision bugs were fixed before
these numbers were published — repository-wide reference resolution, model ids read as file
paths, artifacts excused only on the line that creates them, uppercase path templates, and
indented frontmatter. Every case is pinned in `test/realworld.test.mjs` in the respective repo.
A linter you cannot trust gets uninstalled, so the false positives were treated as the bugs.

## Install

```bash
npm i -D @hyuga/tenken
npx @hyuga/tenken
```

The command it installs is `tenken` — the scope is only how npm finds the package.

## Usage

```bash
tenken                              # check the repository
tenken docs .claude                 # check specific paths
tenken --only carrylint             # one engine
tenken --skip reflint               # all but one
tenken --strict                     # warnings fail too
tenken --format json                # machine-readable
```

| Flag | Effect |
|---|---|
| `--only <engines>` | Comma-separated: `reflint`, `skills-lint`, `carrylint` |
| `--skip <engines>` | Everything except these |
| `--strict` | Exit 1 on warnings as well as errors |
| `--format json` / `--json` | JSON to stdout instead of the text report |
| `--ignore <names>` | Passed to reflint: reference names to leave alone |
| `--allow <names>` | Passed to skills-lint and carrylint: skill names / CLIs to allow |
| `--threshold <n>` | Passed to skills-lint: trigger-similarity threshold (default 0.7) |
| `--code-blocks` | Passed to reflint: check inside fenced code blocks too |
| `--model-ids` | Passed to carrylint: flag hardcoded model identifiers |

Environment: `TENKEN_FORMAT=json`, `TENKEN_STRICT=1`.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | No errors. Warnings may be present unless `--strict` |
| `1` | At least one error (or a warning under `--strict`) |
| `2` | tenken itself could not run — bad flag, unreadable file |

## GitHub Actions

```yaml
- uses: hyuga611/tenken@v0
  with:
    strict: 'false'
```

Findings are emitted as annotations, so they appear inline on the pull request.

## Use it from an agent

[`skills/agent-config-lint/`](skills/agent-config-lint/SKILL.md) is a ready-to-use Agent Skill
that teaches an agent when to run this and how to read the result. Copy the folder into your
skills directory:

```bash
cp -r skills/agent-config-lint ~/.claude/skills/     # Claude Code
cp -r skills/agent-config-lint ~/.openclaw/skills/   # OpenClaw
```

The agent then runs the check on its own before it ships a `SKILL.md`, `AGENTS.md`,
`CLAUDE.md` or `llms.txt` — which is the moment the mistakes are cheapest to fix. The skill
passes this linter itself; that is the point.

## JSON output

```json
{
  "ok": false,
  "count": 3,
  "errors": 3,
  "warnings": 0,
  "engines": { "reflint": 1, "skills-lint": 1, "carrylint": 1 },
  "findings": [
    {
      "file": "AGENTS.md",
      "line": 7,
      "engine": "reflint",
      "kind": "script",
      "severity": "error",
      "message": "`npm run build:docs` — no script \"build:docs\" in package.json"
    }
  ]
}
```

When two engines report the identical finding on the same line it is folded into one entry with an
`engines` array. Different findings on the same line are kept separate — they are different checks.

## Programmatic use

```js
import { collect, run, toJson } from '@hyuga/tenken';

const { findings } = run(collect(['.']), { only: new Set(['carrylint']) });
console.log(toJson(findings));
```

## What it does not do

`tenken` does not add rules, change severities or reinterpret findings. If a finding looks wrong,
it came from one of the three linters and belongs in that repository's issues. Run the engine on
its own to confirm:

```bash
npx @hyuga/carrylint path/to/SKILL.md
```

## License

MIT
