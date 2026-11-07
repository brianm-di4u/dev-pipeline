// Path matching for tier floors. Comparison is case-folded and strips the
// trailing dots and spaces that NTFS ignores, so `.Claude./hooks/x` can't dodge
// a floor that names `.claude/hooks/**`.

export function normalizePath(path) {
  return path
    .replaceAll('\\', '/')
    .split('/')
    .map((segment) => segment.replace(/[. ]+$/, '') || segment)
    .join('/')
    .normalize('NFC')
    .toLowerCase();
}

export function globToRegExp(glob) {
  const source = normalizePath(glob);
  let out = '^';
  for (let i = 0; i < source.length; ) {
    if (source.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
    } else if (source.startsWith('**', i)) {
      out += '.*';
      i += 2;
    } else if (source[i] === '*') {
      out += '[^/]*';
      i += 1;
    } else if (source[i] === '?') {
      out += '[^/]';
      i += 1;
    } else {
      out += source[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`${out}$`);
}

export function matchesAny(path, globs = []) {
  const normalized = normalizePath(path);
  return globs.some((glob) => globToRegExp(glob).test(normalized));
}
