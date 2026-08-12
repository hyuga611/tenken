# Changelog

## 0.3.1

- **`npm i -g` や `npx` で入れた CLI が、何もせずに終了していた。** 入口判定が `process.argv[1]` を
  そのまま `import.meta.url` と比べていた。この2つはシンボリックリンク越しに呼ばれると一致しない
  （`argv[1]` はリンク、`import.meta.url` は解決済みの実パス）ので、install した版は本体を一度も
  実行しないまま exit 0 で終わっていた。リンタにとってこれは最悪の壊れ方で、「問題を見つけなかった」
  と「一度も動いていない」が区別できない。終了コードを読む CI からも同じに見えるので、これを CI に
  入れていた人は、何も守られていない状態で緑を見ていたことになる。公開物を clean なコンテナに
  `npm i -g` して測った結果は、修正前が出力0バイト、修正後は出力あり。
- リンクを解決してから比較するようにし、`test/entrypoint.test.mjs` を追加した。既存のテストは
  すべて関数を import して確かめており、bin を一度も実行していなかったので何も気づけなかった。
  この修正を戻すと、このテストは落ちる（確認済み）。

## 0.3.0

**`--code-blocks` reached no skill at all. Now it does.**

A reference is not always wrapped in backticks or link syntax. A path written as a bare argument
to a runnable command has no markup, and skills-lint finds references by their markup — so it
cannot see that class at all, by construction. reflint's opt-in `--code-blocks` rule is the one
that reads them.

`SKILL.md` is not in reflint's `REF_NAMES`, because skills-lint owns that file. The consequence
was invisible until it cost something: **reflint never received a single `SKILL.md`, so
`--code-blocks` had no effect on skills.** In `openclaw/openclaw`,
`.agents/skills/control-ui-e2e/SKILL.md` told the agent to run a test file that had been renamed,
inside a ` ```bash ` block, and no engine looked there. Eight lines above, the same file names a
path in prose with backticks — skills-lint caught that one. The difference was the markup, not the
severity.

With `--code-blocks`, reflint now also runs over `SKILL.md`, and **only its `code-path` findings
are kept.** Everything else reflint would say about a `SKILL.md` is skills-lint's to say and would
be reported twice; there is a test for that. Default behaviour is unchanged — without the flag,
fenced content is still skipped everywhere.

Requires `@hyuga/reflint` ^0.9.0, where the rule itself went from 133 findings for 1 real defect
to 2 findings for 1, measured on 80 skills across 4 repositories. See reflint's CHANGELOG 0.9.0
for what the other 132 were and why the flag stays opt-in.

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
