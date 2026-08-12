#!/usr/bin/env node
/**
 * tenken — 点検 ("inspection")
 *
 * Runs reflint (reference integrity), skills-lint (skill schema + collisions) and
 * carrylint (runtime portability) over one tree, walking it once, and reports the
 * result as a single list with a single exit code.
 *
 * The three linters stay the source of truth: this file discovers files and calls
 * their exported checks. It contains no rules of its own.
 */
import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, basename, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { scan as refScan, nearestScripts, existsInRepo, isGitIgnored } from '@hyuga/reflint';
import {
  parseFrontmatter,
  checkSkill,
  checkReferenceFiles,
  detectCollisions,
} from '@hyuga/skills-lint';
import { scan as carryScan, DEFAULT_RULES } from '@hyuga/carrylint';

export const ENGINES = ['reflint', 'skills-lint', 'carrylint'];

// What each engine looks at. One walk collects the union.
const REF_NAMES = new Set(['AGENTS.md', 'llms.txt', 'CLAUDE.md']);
const CARRY_NAMES = new Set(['SKILL.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);
const COMMAND_DIRS = [
  ['.claude', 'commands'],
  ['.codex', 'prompts'],
  ['.cursor', 'rules'],
  ['.github', 'prompts'],
];
const SKILL_NAME = 'SKILL.md';

const slash = (p) => p.split(sep).join('/');

function inCommandDir(dir) {
  const d = slash(dir);
  return COMMAND_DIRS.some((seg) => d.includes(seg.join('/')));
}

function inReferencesDir(dir) {
  return /(^|\/)references(\/|$)/.test(slash(dir));
}

/**
 * Walk the tree once and gather the targets for all three engines together.
 * Each entry is { file, name, dir }; deciding which engine wants it is classify's job.
 */
export function collect(paths, { maxDepth = 8 } = {}) {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    const r = slash(p);
    if (seen.has(r)) return;
    seen.add(r);
    out.push({ file: r, name: basename(r), dir: dirname(r) });
  };
  const wanted = (name, dir) =>
    REF_NAMES.has(name) ||
    CARRY_NAMES.has(name) ||
    (/\.(md|txt|mdc)$/i.test(name) && inCommandDir(dir)) ||
    (/\.md$/i.test(name) && inReferencesDir(dir));

  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
        walk(join(dir, e.name), depth + 1);
      } else if (wanted(e.name, dir)) {
        add(join(dir, e.name));
      }
    }
  };

  for (const p of paths) {
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, 0);
    else add(p);
  }
  return out;
}

/** Sort the gathered files by which engine applies to them. */
export function classify(entries) {
  const refFiles = [];
  const skillFiles = [];
  const carryFiles = [];
  const refMdByDir = new Map(); // skill dir → references/*.md

  for (const e of entries) {
    if (REF_NAMES.has(e.name)) refFiles.push(e);
    if (e.name === SKILL_NAME) skillFiles.push(e);
    if (CARRY_NAMES.has(e.name) || inCommandDir(e.dir)) carryFiles.push(e);
    if (/\.md$/i.test(e.name) && inReferencesDir(e.dir)) {
      // A references/ directory belongs to the nearest directory above that segment.
      const owner = slash(e.dir).replace(/\/references(\/.*)?$/, '');
      if (!refMdByDir.has(owner)) refMdByDir.set(owner, []);
      refMdByDir.get(owner).push(e);
    }
  }
  return { refFiles, skillFiles, carryFiles, refMdByDir };
}

const read = (f) => readFileSync(f, 'utf8');

/** Read the rule set carrylint ships, if it can be resolved, and merge it over the defaults. */
function loadCarryRules() {
  try {
    const require_ = createRequire(import.meta.url);
    const raw = JSON.parse(readFileSync(require_.resolve('@hyuga/carrylint/rules.json'), 'utf8'));
    return { ...DEFAULT_RULES, ...raw };
  } catch {
    return DEFAULT_RULES;
  }
}

/**
 * Does `p` resolve, for a document that lives in `dir` inside the tree rooted at `root`?
 *
 * Skill documents were previously resolved against their own folder only. That is right for
 * a standalone published package (root === dir) but wrong for a skill checked into a
 * repository, where `packages/x/y.ts` or `docs/z.md` is a perfectly good reference. Auditing
 * openclaw/openclaw's 46 bundled skills, folder-only resolution called 139 of 197 references
 * broken; every one of them existed in the repo.
 *
 * Deliberately the same predicate reflint's own CLI builds, so the two engines cannot
 * disagree about whether a path exists.
 */
export function existsInSkillOrRepo(dir, root, p) {
  return (
    existsSync(resolve(dir, p)) ||
    existsSync(resolve(root, p)) ||
    existsInRepo(root, p) ||
    isGitIgnored(root, p)
  );
}

/**
 * Run all three engines and return findings in one normalised shape:
 * { file, line, engine, kind, severity, message }
 */
export function run(entries, opts = {}) {
  const {
    root = process.cwd(),
    only = null,
    codeBlocks = false,
    ignore = new Set(),
    allow = new Set(),
    threshold = undefined,
    modelIds = false,
  } = opts;
  const enabled = (name) => !only || only.has(name);
  const { refFiles, skillFiles, carryFiles, refMdByDir } = classify(entries);
  const findings = [];
  const errors = [];
  const push = (engine, file, f, severity) =>
    findings.push({
      file,
      line: f.ln || 1,
      engine,
      kind: f.kind || 'unknown',
      severity: severity || f.severity || 'error',
      message: f.msg,
    });

  // --- reflint: do the references resolve ---
  if (enabled('reflint')) {
    // With --code-blocks, reflint also reads paths written as bare command arguments inside
    // fenced blocks — the one place a reference carries no backticks and no link syntax, so
    // skills-lint's markup-based scan cannot see it. `SKILL.md` is not in REF_NAMES (skills-lint
    // owns it), which meant that check never reached a single skill: openclaw/openclaw's
    // control-ui-e2e ran a renamed test file inside a ```bash block and no engine looked.
    // Reflint runs over skills too, but only its `code-path` findings are kept — everything
    // else it would say about a SKILL.md is skills-lint's to say, and would double-report.
    const targets = [
      ...refFiles.map((e) => ({ ...e, only: null })),
      ...(codeBlocks ? skillFiles.map((e) => ({ ...e, only: 'code-path' })) : []),
    ];
    for (const { file, only } of targets) {
      let text;
      try {
        text = read(file);
      } catch {
        errors.push(`cannot read ${file}`);
        continue;
      }
      const abs = resolve(root, file);
      const fileDir = dirname(abs);
      // Rebuild exactly the exists predicate reflint's own CLI builds. An approximation
      // reports references as missing that reflint itself resolves.
      const exists = (p) =>
        existsSync(resolve(fileDir, p)) ||
        existsSync(resolve(root, p)) ||
        existsInRepo(root, p) ||
        isGitIgnored(root, p);
      const scripts = nearestScripts(fileDir, root);
      for (const f of refScan(text, { scripts, exists, codeBlocks, ignore })) {
        if (only && f.kind !== only) continue;
        push('reflint', file, f, 'error');
      }
    }
  }

  // --- skills-lint: schema, references, collisions between skills ---
  if (enabled('skills-lint')) {
    const skills = [];
    for (const { file, dir } of skillFiles) {
      let text;
      try {
        text = read(file);
      } catch {
        errors.push(`cannot read ${file}`);
        continue;
      }
      const fm = parseFrontmatter(text);
      skills.push({ file, data: fm.data });
      const own = checkSkill({
        ...fm,
        // Same predicate as the reflint block above, for the same reason: a skill that
        // lives inside a repository may reference anything in that repository. Resolving
        // only against the skill's own folder reported 139 of 197 references as missing
        // on openclaw/openclaw's 46 bundled skills (2026-08 audit) — all of them present.
        // For a standalone skill package root === dir, so this is unchanged there.
        exists: (p) => existsInSkillOrRepo(dir, root, p),
        // Strict companion: "is this written as a path here", not "does it resolve anywhere".
        // Without it `openclaw/openclaw` reads as a path because some deep directory happens
        // to be named `openclaw`.
        existsLocal: (p) => existsSync(resolve(dir, p)) || existsSync(resolve(root, p)),
        dirName: basename(dir),
      });
      // Respect a severity the engine set on the finding; default to error.
      for (const f of own) push('skills-lint', file, f, f.severity || 'error');

      const refInputs = [];
      for (const r of refMdByDir.get(slash(dir)) || []) {
        let rtext;
        try {
          rtext = read(r.file);
        } catch {
          continue;
        }
        refInputs.push({
          file: r.file,
          text: rtext,
          exists: (p) => existsInSkillOrRepo(r.dir, root, p),
        });
      }
      for (const f of checkReferenceFiles(refInputs)) {
        push('skills-lint', f.file, f, 'error');
      }
    }
    for (const c of detectCollisions(skills, { threshold, allow })) {
      push('skills-lint', c.file, { ...c, ln: 1 }, 'error');
    }
  }

  // --- carrylint: will it run on someone else's machine ---
  if (enabled('carrylint')) {
    const rules = loadCarryRules();
    for (const { file } of carryFiles) {
      let text;
      try {
        text = read(file);
      } catch {
        errors.push(`cannot read ${file}`);
        continue;
      }
      for (const f of carryScan(text, { rules, allow, modelIds })) {
        push('carrylint', file, f);
      }
    }
  }

  return { findings: dedupe(findings), errors };
}

/**
 * Fold two engines reporting the identical (file, line, kind, message) into one entry.
 * Anything else stays separate — different checks landing on the same line is normal.
 */
export function dedupe(findings) {
  const seen = new Map();
  const out = [];
  for (const f of findings) {
    const key = [f.file, f.line, f.kind, f.message].join('\u0000');
    if (seen.has(key)) {
      const prev = seen.get(key);
      if (!prev.engines) prev.engines = [prev.engine];
      if (!prev.engines.includes(f.engine)) prev.engines.push(f.engine);
      continue;
    }
    seen.set(key, f);
    out.push(f);
  }
  return out;
}

export function toJson(findings, errors = []) {
  const errs = findings.filter((f) => f.severity === 'error').length;
  const byEngine = {};
  for (const e of ENGINES) byEngine[e] = findings.filter((f) => f.engine === e).length;
  return {
    ok: errs === 0 && errors.length === 0,
    count: findings.length,
    errors: errs,
    warnings: findings.length - errs,
    engines: byEngine,
    findings,
    ...(errors.length ? { failures: errors } : {}),
  };
}

// ---------------- CLI ----------------

const asSet = (s) =>
  new Set(
    String(s || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

export function parseArgs(argv) {
  const paths = [];
  let asJson = process.env.TENKEN_FORMAT === 'json';
  let strict = process.env.TENKEN_STRICT === '1';
  let only = null;
  let codeBlocks = false;
  let modelIds = false;
  let threshold;
  const ignore = new Set();
  const allow = new Set();
  const addTo = (set, s) => asSet(s).forEach((x) => set.add(x));
  const engines = (s) => {
    const wanted = asSet(s);
    for (const e of wanted) {
      if (!ENGINES.includes(e)) throw new Error(`unknown engine "${e}" (expected: ${ENGINES.join(', ')})`);
    }
    return wanted;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    else if (a === '--json') asJson = true;
    else if (a === '--format') { if (argv[i + 1] === 'json') asJson = true; i++; }
    else if (a.startsWith('--format=')) { if (a.slice(9) === 'json') asJson = true; }
    else if (a === '--strict') strict = true;
    else if (a === '--code-blocks') codeBlocks = true;
    else if (a === '--model-ids') modelIds = true;
    else if (a === '--only') only = engines(argv[++i]);
    else if (a.startsWith('--only=')) only = engines(a.slice(7));
    // Settle the exclusion set once, outside the filter. Advancing i inside the callback
    // would consume one argv entry per engine.
    else if (a === '--skip') { const drop = engines(argv[++i]); only = new Set(ENGINES.filter((e) => !drop.has(e))); }
    else if (a.startsWith('--skip=')) { const drop = engines(a.slice(7)); only = new Set(ENGINES.filter((e) => !drop.has(e))); }
    else if (a === '--ignore') addTo(ignore, argv[++i]);
    else if (a.startsWith('--ignore=')) addTo(ignore, a.slice(9));
    else if (a === '--allow') addTo(allow, argv[++i]);
    else if (a.startsWith('--allow=')) addTo(allow, a.slice(8));
    else if (a === '--threshold') threshold = parseFloat(argv[++i]);
    else if (a.startsWith('--threshold=')) threshold = parseFloat(a.slice(12));
    else paths.push(a);
  }
  if (Number.isNaN(threshold)) threshold = undefined;
  return { paths, asJson, strict, only, codeBlocks, modelIds, threshold, ignore, allow };
}

function defaultTargets() {
  return ['.'];
}

const PAD = Math.max(...ENGINES.map((e) => e.length));

function report(findings, inActions) {
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  for (const file of [...byFile.keys()].sort()) {
    const fs_ = byFile.get(file);
    fs_.sort((a, b) => a.line - b.line);
    console.error(`✗ ${file} — ${fs_.length} problem${fs_.length === 1 ? '' : 's'}`);
    for (const f of fs_) {
      const tag = `[${f.engines ? f.engines.join('+') : f.engine}]`.padEnd(PAD + 2);
      const mark = f.severity === 'warn' ? '!' : ' ';
      console.error(`  ${mark} ${tag} ${file}:${f.line}\t${f.message}`);
      if (inActions) {
        const level = f.severity === 'warn' ? 'warning' : 'error';
        console.log(`::${level} file=${file},line=${f.line}::${f.message.replace(/\r?\n/g, ' ')}`);
      }
    }
  }
}

export function main(argv) {
  const inActions = process.env.GITHUB_ACTIONS === 'true';
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`tenken: ${e.message}`);
    return 2;
  }
  const { paths, asJson, strict, only, codeBlocks, modelIds, threshold, ignore, allow } = args;

  const entries = collect(paths.length ? paths : defaultTargets());
  if (entries.length === 0) {
    if (asJson) console.log(JSON.stringify(toJson([], []), null, 2));
    else console.log('tenken: no agent config found (SKILL.md / AGENTS.md / CLAUDE.md / llms.txt) — skipping.');
    return 0;
  }

  const { findings, errors } = run(entries, {
    root: process.cwd(),
    only,
    codeBlocks,
    ignore,
    allow,
    threshold,
    modelIds,
  });

  if (asJson) {
    console.log(JSON.stringify(toJson(findings, errors), null, 2));
  } else {
    report(findings, inActions);
    for (const e of errors) console.error(`tenken: ${e}`);
  }

  const errCount = findings.filter((f) => f.severity === 'error').length;
  const warnCount = findings.length - errCount;

  if (!asJson) {
    if (findings.length === 0 && errors.length === 0) {
      const ran = (only ? [...only] : ENGINES).join(', ');
      console.log(`tenken: ${entries.length} file${entries.length === 1 ? '' : 's'}, all clean (${ran})`);
    } else {
      const parts = ENGINES.filter((e) => findings.some((f) => f.engine === e)).map(
        (e) => `${e} ${findings.filter((f) => f.engine === e).length}`,
      );
      console.error(
        `\ntenken: ${findings.length} problem${findings.length === 1 ? '' : 's'} ` +
          `(${errCount} error${errCount === 1 ? '' : 's'}, ${warnCount} warning${warnCount === 1 ? '' : 's'})` +
          (parts.length ? ` — ${parts.join(', ')}` : ''),
      );
    }
  }

  if (errors.length) return 2;
  if (errCount > 0) return 1;
  if (strict && warnCount > 0) return 1;
  return 0;
}

/**
 * Was this run directly, or imported?
 *
 * argv[1] is the path as invoked, and both `npm i -g` and `npx` put a symlink
 * there. import.meta.url is the resolved real path, so the two never matched for
 * an installed copy and the CLI did nothing at all: exit 0, no output. That is the
 * worst way for a linter to break, because "found no problems" and "never ran" are
 * the same observation — and a CI step reading the exit code cannot tell them
 * apart either. Resolve the link before comparing.
 */
function runDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  if (import.meta.url === pathToFileURL(arg).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(arg)).href;
  } catch {
    return false;
  }
}

if (runDirectly()) {
  process.exit(main(process.argv.slice(2)));
}
