# tenken — notes for agents working on this repository

`tenken` runs three linters over a tree in one pass. It owns discovery and reporting; it owns no
rules.

## Layout

- `src/check.mjs` — the whole implementation: walk, classify, run, report, CLI
- `test/check.test.mjs` — unit tests
- `examples/good` — a clean tree; tenken must stay silent on it
- `examples/bad` — a deliberately broken tree; every finding in it is intentional

## Working on it

Run `npm run test` for the unit tests and `npm run poc` to see the report on the broken fixture.

## Rules of the house

- **No lint rules live here.** If a finding is wrong, fix it in reflint, skills-lint or carrylint.
  Adding a special case in this repository hides the defect from everyone using those linters
  directly.
- **Reproduce each engine's own behaviour exactly.** reflint's accuracy depends on the `exists`
  predicate its CLI builds (file directory, then repository root, then a repository-wide index,
  then `.gitignore`). Substituting a simpler check reports references as missing that reflint
  itself resolves. The same applies to the rule set carrylint ships alongside its source.
- **Walk once.** The point of this package is that a repository is traversed a single time. New
  checks reuse the collected entries rather than walking again.
- **Keep the three engines independent.** They are separately published and separately useful.
