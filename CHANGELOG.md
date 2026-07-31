# Changelog

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
