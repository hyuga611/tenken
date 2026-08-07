import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ENGINES, collect, classify, dedupe, parseArgs, run, toJson, main } from '../src/check.mjs';

// ---------------- collect ----------------

test('collect finds every engine target in one walk', () => {
  const files = collect(['examples/bad']).map((e) => e.file);
  assert.ok(files.includes('examples/bad/AGENTS.md'));
  assert.ok(files.includes('examples/bad/.claude/skills/leaky/SKILL.md'));
});

test('collect picks up references/*.md so skills-lint can check them', () => {
  const files = collect(['examples/good']).map((e) => e.file);
  assert.ok(files.includes('examples/good/.claude/skills/portable-thing/references/template.md'));
});

test('collect skips node_modules and .git', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tenken-'));
  try {
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(dir, '.git', 'x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'AGENTS.md'), '# nope\n');
    writeFileSync(join(dir, '.git', 'x', 'AGENTS.md'), '# nope\n');
    writeFileSync(join(dir, 'AGENTS.md'), '# yes\n');
    assert.equal(collect([dir]).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collect de-duplicates a path passed twice', () => {
  const files = collect(['examples/bad/AGENTS.md', 'examples/bad/AGENTS.md']);
  assert.equal(files.length, 1);
});

// ---------------- classify ----------------

test('classify routes each file to the engines that apply', () => {
  const { refFiles, skillFiles, carryFiles } = classify(collect(['examples/bad']));
  const names = (xs) => xs.map((e) => e.file).sort();
  assert.deepEqual(names(refFiles), ['examples/bad/AGENTS.md']);
  assert.deepEqual(names(skillFiles), ['examples/bad/.claude/skills/leaky/SKILL.md']);
  // AGENTS.md and SKILL.md are both portability targets
  assert.equal(carryFiles.length, 2);
});

test('classify attributes references/*.md to the owning skill directory', () => {
  const { refMdByDir } = classify(collect(['examples/good']));
  const owner = 'examples/good/.claude/skills/portable-thing';
  assert.ok(refMdByDir.has(owner));
  assert.equal(refMdByDir.get(owner)[0].file, `${owner}/references/template.md`);
});

// ---------------- dedupe ----------------

test('dedupe folds an identical finding reported by two engines', () => {
  const out = dedupe([
    { file: 'a.md', line: 1, kind: 'abs-path', message: 'same', engine: 'reflint', severity: 'error' },
    { file: 'a.md', line: 1, kind: 'abs-path', message: 'same', engine: 'carrylint', severity: 'error' },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].engines, ['reflint', 'carrylint']);
});

test('dedupe keeps different findings on the same line', () => {
  const out = dedupe([
    { file: 'a.md', line: 1, kind: 'abs-path', message: 'one', engine: 'reflint', severity: 'error' },
    { file: 'a.md', line: 1, kind: 'placeholder', message: 'two', engine: 'carrylint', severity: 'error' },
  ]);
  assert.equal(out.length, 2);
});

// ---------------- parseArgs ----------------

test('--skip consumes exactly one argument', () => {
  // regression: evaluating the engine set inside Array.filter advanced argv once per engine,
  // which silently dropped the skip and swallowed the path that followed.
  const a = parseArgs(['--skip', 'carrylint', 'examples/bad']);
  assert.deepEqual([...a.only].sort(), ['reflint', 'skills-lint']);
  assert.deepEqual(a.paths, ['examples/bad']);
});

test('--skip with several engines leaves the rest enabled', () => {
  const a = parseArgs(['--skip', 'carrylint,skills-lint']);
  assert.deepEqual([...a.only], ['reflint']);
});

test('--only and --skip= parse to the same shape', () => {
  assert.deepEqual([...parseArgs(['--only', 'reflint']).only], ['reflint']);
  assert.deepEqual([...parseArgs(['--only=reflint']).only], ['reflint']);
  assert.deepEqual([...parseArgs(['--skip=carrylint,skills-lint']).only], ['reflint']);
});

test('an unknown engine name is rejected', () => {
  assert.throws(() => parseArgs(['--only', 'nope']), /unknown engine "nope"/);
});

test('json and strict flags parse in every accepted spelling', () => {
  assert.equal(parseArgs(['--json']).asJson, true);
  assert.equal(parseArgs(['--format', 'json']).asJson, true);
  assert.equal(parseArgs(['--format=json']).asJson, true);
  assert.equal(parseArgs(['--strict']).strict, true);
  assert.equal(parseArgs([]).asJson, false);
});

test('--format json does not swallow the path that follows', () => {
  assert.deepEqual(parseArgs(['--format', 'json', 'examples/bad']).paths, ['examples/bad']);
});

// ---------------- run ----------------

test('every engine reports on the broken fixture', () => {
  const { findings, errors } = run(collect(['examples/bad']));
  assert.equal(errors.length, 0);
  for (const e of ENGINES) {
    assert.ok(
      findings.some((f) => f.engine === e),
      `${e} reported nothing on examples/bad`,
    );
  }
});

test('reflint keeps the exists resolver it uses on its own', () => {
  // `src/check.mjs` is referenced by examples/good/AGENTS.md and lives at the repo root:
  // it resolves only because the repo-wide index is consulted, as reflint's own CLI does.
  const { findings } = run(collect(['examples/good']), { only: new Set(['reflint']) });
  assert.deepEqual(findings, []);
});

test('no engine reports on the clean fixture', () => {
  const { findings, errors } = run(collect(['examples/good']));
  assert.deepEqual(findings, []);
  assert.equal(errors.length, 0);
});

test('only runs the engines that were selected', () => {
  const { findings } = run(collect(['examples/bad']), { only: new Set(['carrylint']) });
  assert.ok(findings.length > 0);
  assert.ok(findings.every((f) => f.engine === 'carrylint'));
});

// ---------------- toJson ----------------

test('toJson counts errors and warnings separately', () => {
  const j = toJson([
    { file: 'a', line: 1, engine: 'carrylint', kind: 'todo', severity: 'warn', message: 'x' },
    { file: 'a', line: 2, engine: 'reflint', kind: 'path', severity: 'error', message: 'y' },
  ]);
  assert.equal(j.ok, false);
  assert.equal(j.errors, 1);
  assert.equal(j.warnings, 1);
  assert.equal(j.engines.carrylint, 1);
});

test('toJson is ok when only warnings are present', () => {
  const j = toJson([{ file: 'a', line: 1, engine: 'carrylint', kind: 'todo', severity: 'warn', message: 'x' }]);
  assert.equal(j.ok, true);
});

// ---------------- main / exit codes ----------------

function quiet(fn) {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

test('main exits 0 on a clean tree and 1 when something is broken', () => {
  assert.equal(quiet(() => main(['examples/good'])), 0);
  assert.equal(quiet(() => main(['examples/bad'])), 1);
});

test('main exits 2 on an unknown engine name', () => {
  assert.equal(quiet(() => main(['--only', 'nope'])), 2);
});

test('main exits 0 when there is nothing to check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tenken-'));
  try {
    assert.equal(quiet(() => main([dir])), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('warnings do not fail the run unless --strict is given', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tenken-'));
  try {
    // a TODO marker is a carrylint warning and nothing else
    writeFileSync(join(dir, 'AGENTS.md'), '# Example\n\nTODO: write this section.\n');
    const { findings } = run(collect([dir]), { root: dir });
    assert.ok(findings.length > 0, 'expected at least one warning');
    assert.ok(findings.every((f) => f.severity === 'warn'));
    assert.equal(quiet(() => main([dir])), 0);
    assert.equal(quiet(() => main([dir, '--strict'])), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------- --code-blocks reaches SKILL.md ----------------

/**
 * A path written as a bare command argument inside a fenced block carries no backticks and no
 * link syntax, so skills-lint's markup-based scan cannot see it. reflint's --code-blocks rule can,
 * but SKILL.md is not in REF_NAMES, so that check used to reach no skill at all. Reproduces
 * openclaw/openclaw's control-ui-e2e, which ran a renamed test file inside a ```bash block.
 */
function skillWithFencedPath(dir) {
  const sk = join(dir, '.claude', 'skills', 'ui-e2e');
  mkdirSync(sk, { recursive: true });
  mkdirSync(join(dir, 'ui', 'src', 'e2e'), { recursive: true });
  writeFileSync(join(dir, 'ui', 'src', 'e2e', 'kept.e2e.test.ts'), '');
  writeFileSync(
    join(sk, 'SKILL.md'),
    [
      '---',
      'name: ui-e2e',
      'description: Run one Control UI end-to-end test in a worktree and report the result.',
      '---',
      '',
      '# UI E2E',
      '',
      '```bash',
      'node --test ui/src/ui/e2e/gone.e2e.test.ts',
      '```',
      '',
    ].join('\n'),
  );
}

test('--code-blocks: reflint reads bare command paths in SKILL.md (default does not)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tenken-'));
  try {
    skillWithFencedPath(dir);
    const entries = collect([dir]);

    const off = run(entries, { root: dir }).findings;
    assert.equal(off.filter((f) => f.kind === 'code-path').length, 0);

    const on = run(entries, { root: dir, codeBlocks: true }).findings;
    const hit = on.filter((f) => f.kind === 'code-path');
    assert.equal(hit.length, 1);
    assert.equal(hit[0].engine, 'reflint');
    assert.match(hit[0].file, /SKILL\.md$/);
    assert.match(hit[0].message, /gone\.e2e\.test\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--code-blocks: reflint says nothing else about a SKILL.md (skills-lint owns it)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tenken-'));
  try {
    const sk = join(dir, '.claude', 'skills', 'thing');
    mkdirSync(sk, { recursive: true });
    // A backticked path that does not resolve: skills-lint's finding, not reflint's.
    writeFileSync(
      join(sk, 'SKILL.md'),
      ['---', 'name: thing', 'description: Do the thing and report what changed.', '---', '', 'Read `docs/gone.md`.', ''].join('\n'),
    );
    const { findings } = run(collect([dir]), { root: dir, codeBlocks: true });
    const onSkill = findings.filter((f) => /SKILL\.md$/.test(f.file) && f.message.includes('docs/gone.md'));
    assert.equal(onSkill.length, 1, 'the same reference must not be reported by two engines');
    assert.equal(onSkill[0].engine, 'skills-lint');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
