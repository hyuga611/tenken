# Changelog

## 0.2.0

- **skills-lint now resolves references the same way reflint does.** 0.1.0 promised that "a
  reference that reflint resolves is not reported as missing here", and built reflint's
  `exists` predicate exactly. skills-lint was handed a different one that looked only inside
  the skill's own folder — so a skill checked into a repository had every reference to
  `packages/…`, `docs/…` or `qa/…` reported broken. Auditing the 46 skills bundled in
  [openclaw/openclaw](https://github.com/openclaw/openclaw), **139 of 197 reported references
  existed in the repo**. Both engines now go through one shared `existsInSkillOrRepo`, so they
  cannot disagree. For a standalone skill package `root === dir` and nothing changes.
- **A stricter companion predicate decides whether something is written as a path at all.**
  Resolving repository-wide is right for "does this exist", but too generous for "is this a
  path": it made `openclaw/openclaw` look repo-relative because a deep Java package directory
  is named `openclaw`. skills-lint 0.7.0 accepts `existsLocal` for that test and tenken passes
  a dir-and-root-only predicate.

- **A severity set by an engine is no longer overwritten.** skills-lint findings were pushed
  as `error` unconditionally, so a finding the engine deliberately marked `warn` still failed
  the build. The engine's own severity now wins, defaulting to `error` when it sets none.

Requires `@hyuga/skills-lint` ≥ 0.7.0 and `@hyuga/carrylint` ≥ 0.2.2. On the openclaw corpus these two changes plus the
skills-lint 0.7.0 precision fixes take **201 errors → 43**, with all 13 genuine defects — a
maintainer's home directory hardcoded in a shipped skill among them — still reported.

## 0.1.0

First release.

- Runs [reflint](https://github.com/hyuga611/reflint), [skills-lint](https://github.com/hyuga611/skills-lint)
  and [carrylint](https://github.com/hyuga611/carrylint) over one tree in a single walk, and reports
  the result as one list with one exit code.
- No rules of its own: file discovery happens here, every judgement comes from the three linters'
  exported checks. reflint's `exists` predicate is rebuilt exactly as its CLI builds it, so a
  reference that reflint resolves is not reported as missing here.
- `--only` / `--skip` to select engines, `--strict` to fail on warnings, `--format json`, and a
  composite GitHub Action that emits findings as inline annotations.
- Identical findings reported by two engines on the same line are folded into one entry; different
  findings on the same line are kept apart.
