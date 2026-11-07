// Git plumbing. Everything here reads objects only. Nothing checks out or runs
// PR content, so it is safe on untrusted refs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function tryGit(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

export function mergeBase(base, head, cwd) {
  return git(['merge-base', base, head], cwd).trim();
}

// `-z` output is `:oldMode newMode oldSha newSha status\0path\0`. Rename
// detection is off, so a move shows up as a delete of the source and an add of
// the destination, and both paths reach the tier floors.
export function parseRawDiff(raw) {
  const fields = raw.split('\0');
  const changes = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode, newMode, oldSha, newSha, status] = fields[i].replace(/^:/, '').split(' ');
    changes.push({ oldMode, newMode, oldSha, newSha, status, path: fields[i + 1] });
  }
  return changes;
}

export function rawChanges(from, to, cwd) {
  const raw = git(
    ['diff-tree', '-r', '-z', '--no-renames', '--raw', '--no-abbrev', '--ignore-submodules=none', from, to],
    cwd,
  );
  return parseRawDiff(raw);
}

// The change hash binds a verdict or approval to the content of a change. It
// covers every changed path's modes and blob IDs from the merge base, so
// whitespace and binaries count, a clean rebase keeps it, and any content
// change voids it. Records are sorted here so `diff.orderFile` can't affect it.
export function hashChanges(changes) {
  const lines = changes
    .map((c) => [c.path, c.oldMode, c.newMode, c.oldSha, c.newSha].join(' '))
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export function changeSet(baseRef, headRef, cwd) {
  const base = mergeBase(baseRef, headRef, cwd);
  const changes = rawChanges(base, headRef, cwd);
  return { mergeBase: base, changes, hash: hashChanges(changes) };
}

export function readBlob(ref, path, cwd) {
  return tryGit(['show', `${ref}:${path}`], cwd);
}

export function commitMessage(ref, cwd) {
  return git(['log', '-1', '--format=%B', ref], cwd);
}

export function isAncestor(ancestor, descendant, cwd) {
  return tryGit(['merge-base', '--is-ancestor', ancestor, descendant], cwd) !== null;
}
