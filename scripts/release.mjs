#!/usr/bin/env node
// Cut a release, per component.
//
// The problem this solves: one git tag used to mean "this commit", so an
// api-only change still minted a new version for web and mobile and rebuilt
// both images. Here each component carries its own tag line and only moves when
// something it is actually built from has changed.
//
// "Changed" is not a guess: it is the workspace dependency graph applied to the
// files a range actually touched. A commit in packages/charts reaches web and
// nothing else, one in packages/validation reaches all three. Commit *scopes*
// deliberately play no part in this — the
// vocabulary drifted from component-shaped (api, web, db) to feature-shaped
// (payments, jobs, reports), so `fix(payments)` cannot say which artifact moved.
// Commit *types* are still uniform, so they set the bump size and nothing else.
//
// Signing and the release sentence stay manual on purpose: CI cannot sign with
// your key, and "a new number every merge" is not a release note. This computes,
// you approve, you push.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { compare } from './contract-check.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// The things that ship. android and ios build from the same apps/mobile source,
// so no diff can tell them apart and they share one line; they diverge only by
// which store has accepted which build, which is a counter, not a version.
const COMPONENTS = [
  { id: 'api', pkg: '@thalermark/api', ships: 'GHCR image' },
  { id: 'web', pkg: '@thalermark/web', ships: 'GHCR image' },
  { id: 'mobile', pkg: '@thalermark/mobile', ships: 'Play Store / App Store' },
];

const SNAPSHOT = 'packages/api-contract/contract.snapshot.json';

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

// Same, but git's stderr is expected output rather than a problem: asking for a
// file that did not exist at an old tag is how we detect the first release under
// this scheme, not an error worth printing.
function gitQuiet(...args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function die(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

// Every workspace package, with its directory and its @thalermark/* edges.
function workspaceGraph() {
  const graph = new Map();
  for (const base of ['apps', 'packages']) {
    for (const entry of readdirSync(join(ROOT, base))) {
      const manifest = join(ROOT, base, entry, 'package.json');
      if (!existsSync(manifest)) continue;
      const json = JSON.parse(readFileSync(manifest, 'utf8'));
      const deps = Object.keys({ ...json.dependencies, ...json.devDependencies }).filter((d) =>
        d.startsWith('@thalermark/'),
      );
      graph.set(json.name, { dir: `${base}/${entry}`, deps });
    }
  }
  return graph;
}

// The one dependency edge that must not be followed. api-contract devDepends on
// the api app purely to re-export its route types. Followed naively, a comment
// in an api handler reaches api-contract, then web and mobile, and every
// api-only change bumps all three — the exact drift this script exists to stop.
//
// What web and mobile actually depend on is the api's WIRE CONTRACT, not its
// internals, and that has its own committed artifact next door
// (packages/api-contract/contract.snapshot.json). Because the snapshot lives
// inside a directory both clients already watch, cutting this edge does not lose
// the signal: change a response shape and the snapshot moves with it, so they
// are correctly implicated. Change an internal, and they are correctly left
// alone.
const TYPE_ONLY_EDGES = new Map([['@thalermark/api-contract', '@thalermark/api']]);

function closure(graph, name, seen = new Set()) {
  if (seen.has(name)) return seen;
  seen.add(name);
  for (const dep of graph.get(name)?.deps ?? []) {
    if (TYPE_ONLY_EDGES.get(name) === dep) continue;
    closure(graph, dep, seen);
  }
  return seen;
}

// Root files that change how everything is built.
const ROOT_BUILD_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'turbo.json',
  'tsconfig.base.json',
];
const LOCKFILE = 'pnpm-lock.yaml';

function changedPaths(range) {
  const out = git('diff', '--name-only', range);
  return out ? out.split('\n').filter(Boolean) : [];
}

// Did anything this component is built from actually change?
function isAffected(graph, pkg, paths) {
  if (paths.some((path) => ROOT_BUILD_FILES.includes(path))) return true;
  // A dependency bump names the package whose manifest moved, so that is the
  // signal. A bare lockfile edit (a plain `pnpm update`) names nobody, so it has
  // to count for everyone; over-versioning is merely noisy, under-versioning
  // ships an image whose contents nobody can identify.
  const manifests = paths.filter((path) => /^(apps|packages)\/[^/]+\/package\.json$/.test(path));
  if (paths.includes(LOCKFILE) && !manifests.length) return true;
  const dirs = sourceDirs(graph, pkg);
  return paths.some((path) => dirs.some((dir) => path === dir || path.startsWith(`${dir}/`)));
}

// The directories a component is built from: its own, plus every workspace
// package it depends on, transitively. Used to attribute individual commits for
// the bump size; isAffected owns the yes/no question above.
function sourceDirs(graph, pkg) {
  return [...closure(graph, pkg)].map((name) => graph.get(name)?.dir).filter(Boolean);
}

function commitsTouching(range, dirs) {
  const out = git('log', '--format=%s%x00%b%x1e', range, '--', ...dirs);
  if (!out) return [];
  return out
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [subject, body = ''] = record.split('\x00');
      return { subject, body };
    });
}

// feat -> minor, fix/perf/anything else -> patch, `!` or a BREAKING CHANGE
// trailer -> major. Only consulted once a component is off a prerelease train.
function bumpLevel(commits) {
  let level = 'patch';
  for (const { subject, body } of commits) {
    const match = /^(\w+)(\([^)]*\))?(!)?:/.exec(subject);
    if (!match) continue;
    if (match[3] || /^BREAKING[ -]CHANGE:/m.test(body)) return 'major';
    if (match[1] === 'feat' && level === 'patch') level = 'minor';
  }
  return level;
}

function summarize(commits) {
  const counts = new Map();
  for (const { subject } of commits) {
    const match = /^(\w+)(\([^)]*\))?!?:/.exec(subject);
    const type = match ? match[1] : 'other';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${n} ${type}`)
    .join(', ');
}

// On a prerelease train (0.1.0-beta.25) a bump advances the counter and the
// level is informational only. Changing trains (beta -> rc, 0.x -> 1.0.0) is a
// deliberate act, so it is an explicit override rather than something inferred.
function nextVersion(current, level) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(current);
  if (!match) return null;
  const [, major, minor, patch, pre] = match;
  if (pre) {
    const counter = /^(.*?)(\d+)$/.exec(pre);
    return counter ? `v${major}.${minor}.${patch}-${counter[1]}${Number(counter[2]) + 1}` : null;
  }
  if (level === 'major') return `v${Number(major) + 1}.0.0`;
  if (level === 'minor') return `v${major}.${Number(minor) + 1}.0`;
  return `v${major}.${minor}.${Number(patch) + 1}`;
}

// Does `to` raise the major above `from`? A hard-coded version is a statement
// about the NUMBER, not a promise about compatibility, so it does not by itself
// buy a pass on the contract gate. Going 0.x -> 1.0.0-rc.1 does, because that is
// what a major means.
function isMajorIncrease(from, to) {
  const parse = (value) => Number(/^v?(\d+)\./.exec(value)?.[1] ?? Number.NaN);
  const before = parse(from);
  const after = parse(to);
  return Number.isFinite(before) && Number.isFinite(after) && after > before;
}

// The nearest release tag in HEAD's own history. Not "the most recently created
// tag": creation dates tie when two lines are seeded together, and a tag made on
// another branch was never part of this history at all. Topology is the question
// actually being asked, and git answers it directly.
function describeNearest(glob) {
  try {
    return gitQuiet('describe', '--tags', '--abbrev=0', '--match', glob, 'HEAD') || null;
  } catch {
    return null;
  }
}

// A component's own last release, or the single pre-split tag line it inherits
// from on the first run under this scheme.
function lastRelease(id) {
  const own = describeNearest(`${id}-v*`);
  if (own) return { tag: own, version: own.slice(id.length + 1), seeded: false };
  const legacy = describeNearest('v*');
  if (legacy && /^v\d/.test(legacy)) return { tag: legacy, version: legacy, seeded: true };
  return null;
}

// What changed in the wire contract since a given tag. Both sides are committed
// JSON, so this is a plain diff with no TypeScript involved.
function contractDrift(sinceTag) {
  let before;
  try {
    before = JSON.parse(gitQuiet('show', `${sinceTag}:${SNAPSHOT}`));
  } catch {
    return null; // No snapshot at that tag; nothing to compare against yet.
  }
  let after;
  try {
    after = JSON.parse(readFileSync(join(ROOT, SNAPSHOT), 'utf8'));
  } catch {
    return null;
  }
  return compare(before, after);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const overrides = new Map();
  for (const arg of args) {
    const match = /^--(\w+)=(.+)$/.exec(arg);
    if (match && COMPONENTS.some((c) => c.id === match[1])) {
      overrides.set(match[1], match[2].startsWith('v') ? match[2] : `v${match[2]}`);
    }
  }

  if (git('status', '--porcelain')) die('Working tree is dirty. Commit or stash first.');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') die(`Releases are cut from main; you are on '${branch}'.`);
  git('fetch', '--tags', '--quiet');
  if (git('rev-list', '--count', 'HEAD..origin/main') !== '0') {
    die('main is behind origin/main. Pull first.');
  }

  const graph = workspaceGraph();
  const head = git('rev-parse', '--short', 'HEAD');
  const plan = [];

  for (const component of COMPONENTS) {
    const previous = lastRelease(component.id);
    if (!previous) {
      plan.push({ ...component, status: 'first', next: overrides.get(component.id) ?? 'v0.1.0' });
      continue;
    }
    const range = `${previous.tag}..HEAD`;
    const commits = commitsTouching(range, sourceDirs(graph, component.pkg));
    const changed = isAffected(graph, component.pkg, changedPaths(range));
    const override = overrides.get(component.id);

    if (!changed && !override) {
      plan.push({ ...component, previous, status: 'unchanged' });
      continue;
    }
    const level = bumpLevel(commits);
    const next = override ?? nextVersion(previous.version, level);
    if (!next) {
      die(
        `Cannot derive the next version from '${previous.version}'. Pass --${component.id}=<version>.`,
      );
    }
    plan.push({
      ...component,
      previous,
      status: override ? 'override' : 'bump',
      level,
      commits,
      next,
    });
  }

  console.log(`\n  Release plan  (main @ ${head})\n`);
  for (const entry of plan) {
    const from = entry.previous ? entry.previous.version : '(none)';
    if (entry.status === 'unchanged') {
      console.log(`  ${entry.id.padEnd(8)} ${from.padEnd(18)} unchanged, nothing to ship`);
      continue;
    }
    const detail =
      entry.status === 'override'
        ? 'explicit override'
        : `${entry.commits.length} commits (${summarize(entry.commits)}) -> ${entry.level}`;
    console.log(`  ${entry.id.padEnd(8)} ${from.padEnd(18)} -> ${entry.next}`);
    console.log(`  ${' '.repeat(8)} ${' '.repeat(18)}    ${detail}`);
    if (entry.previous?.seeded) {
      console.log(
        `  ${' '.repeat(8)} ${' '.repeat(18)}    seeded from the shared tag ${entry.previous.tag}`,
      );
    }
  }

  // The api owns the contract that web and installed phone apps read. A release
  // that breaks it without saying so is the failure this whole scheme exists to
  // prevent, so it stops here rather than being a note in the release sentence.
  const api = plan.find((entry) => entry.id === 'api' && entry.status !== 'unchanged');
  if (api?.previous) {
    const drift = contractDrift(api.previous.tag);
    if (drift === null) {
      console.log(
        '\n  No contract snapshot at the previous tag; skipping the compatibility check.',
      );
    } else if (
      drift.breaking.length &&
      api.level !== 'major' &&
      !isMajorIncrease(api.previous.version, api.next)
    ) {
      console.error(
        `\n  BREAKING API CHANGE since ${api.previous.tag} (${drift.breaking.length})\n`,
      );
      for (const { route, detail } of drift.breaking.slice(0, 20)) {
        console.error(`    ${route}\n        ${detail}`);
      }
      if (drift.breaking.length > 20) {
        console.error(`    ... and ${drift.breaking.length - 20} more`);
      }
      die(
        'Refusing to release. Installed phone apps and cached web builds read this\n' +
          '  contract, and none of the commits in this range declare a breaking change.\n\n' +
          '  Either restore compatibility, or mark the commit breaking so this lands as a\n' +
          '  major. A hard-coded --api=<version> only clears this if it raises the major.',
      );
    } else if (drift.breaking.length) {
      console.log(
        `\n  ${drift.breaking.length} declared breaking contract change(s) in this release.`,
      );
    }
  }

  const releasing = plan.filter((entry) => entry.next && entry.status !== 'unchanged');
  if (!releasing.length) {
    console.log('\n  Nothing has changed since the last release. Done.\n');
    return;
  }
  console.log(`\n  Tagging ${releasing.length} of ${COMPONENTS.length} components.\n`);
  if (dryRun) {
    console.log('  --dry-run, stopping here.\n');
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let sentence;
  try {
    sentence = (await rl.question('  Release sentence (one plain user-facing line):\n  > ')).trim();
    if (!sentence) die('No sentence given, nothing tagged.');
    const confirm = (await rl.question('\n  Create these signed tags? [y/N] '))
      .trim()
      .toLowerCase();
    if (confirm !== 'y') die('Cancelled, nothing tagged.');
  } finally {
    rl.close();
  }

  const created = [];
  for (const entry of releasing) {
    const tag = `${entry.id}-${entry.next}`;
    git('tag', '-s', tag, '-m', sentence);
    created.push(tag);
  }
  console.log(`\n  Created: ${created.join(', ')}`);
  console.log('\n  Nothing is published until you push. When ready:\n');
  console.log(`    git push origin ${created.join(' ')}\n`);
}

main().catch((error) => die(error.message));
