// A small GitHub REST client: fetch with a token in CI, the gh CLI locally.
import { execFileSync } from 'node:child_process';

export function tokenClient(token, baseUrl = 'https://api.github.com') {
  const request = async (method, path, body) => {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pipeline-gate',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${await response.text()}`);
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
    const text = await response.text();
    return { data: text ? JSON.parse(text) : null, next };
  };
  return {
    get: async (path) => (await request('GET', path)).data,
    post: async (path, body) => (await request('POST', path, body)).data,
    patch: async (path, body) => (await request('PATCH', path, body)).data,
    list: async (path) => {
      const items = [];
      let cursor = path;
      while (cursor) {
        const { data, next } = await request('GET', cursor);
        items.push(...(Array.isArray(data) ? data : (data.check_runs ?? data.items ?? [])));
        cursor = next;
      }
      return items;
    },
  };
}

export function cliClient() {
  const gh = (args, input) =>
    JSON.parse(
      execFileSync('gh', ['api', ...args], {
        encoding: 'utf8',
        input,
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) || 'null',
    );
  return {
    get: async (path) => gh([path]),
    post: async (path, body) => gh(['-X', 'POST', path, '--input', '-'], JSON.stringify(body)),
    patch: async (path, body) => gh(['-X', 'PATCH', path, '--input', '-'], JSON.stringify(body)),
    list: async (path) => {
      const pages = gh(['--paginate', '--slurp', path]);
      return pages.flat().flatMap((page) => (page?.check_runs ?? page?.items ?? [page]));
    },
  };
}
