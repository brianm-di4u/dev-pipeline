// A tiny in-memory GitHub for the REST paths the pipeline uses, so monitor, gate
// and state code can be tested without the network. Every call is recorded.
export const BOT_USER = { login: 'github-actions[bot]', type: 'Bot' };

// `routes` answers any other path exactly: { 'GET /repos/o/r/x': value, 'LIST /repos/o/r/y': [...] }.
export function fakeGitHub({ issues = [], comments = {}, pulls = [], commits = {}, events = {}, checkRuns = {}, runs = {}, routes = {} } = {}) {
  const state = {
    issues: issues.map((issue) => ({ state: 'open', labels: [], user: BOT_USER, body: '', ...issue })),
    comments: Object.fromEntries(Object.entries(comments).map(([k, v]) => [k, [...v]])),
    pulls,
    commits,
    events,
    checkRuns,
    runs,
    calls: [],
    nextId: 5000,
  };
  const labelsOf = (issue) => issue.labels.map((l) => (typeof l === 'string' ? l : l.name));

  const list = async (path) => {
    state.calls.push({ method: 'LIST', path });
    const url = new URL(path, 'https://api.github.test');
    const q = url.searchParams;
    if (`LIST ${url.pathname}` in routes) return routes[`LIST ${url.pathname}`];
    let m;
    if ((m = /\/issues\/(\d+)\/comments$/.exec(url.pathname))) return state.comments[m[1]] ?? [];
    if ((m = /\/issues\/(\d+)\/events$/.exec(url.pathname))) return state.events[m[1]] ?? [];
    if ((m = /\/pulls\/(\d+)\/commits$/.exec(url.pathname))) return state.commits[m[1]] ?? [];
    if ((m = /\/commits\/([^/]+)\/check-runs$/.exec(url.pathname))) return state.checkRuns[m[1]] ?? [];
    if (/\/issues$/.test(url.pathname)) {
      return state.issues
        .filter((issue) => (q.get('state') ?? 'open') === 'all' || issue.state === (q.get('state') ?? 'open'))
        .filter((issue) => !q.get('labels') || q.get('labels').split(',').every((l) => labelsOf(issue).includes(l)))
        .filter((issue) => !q.get('creator') || issue.user?.login === q.get('creator'))
        .sort((a, b) => b.number - a.number);
    }
    if (/\/pulls$/.test(url.pathname)) {
      return state.pulls.filter((pr) => !q.get('state') || q.get('state') === 'all' || pr.state === q.get('state'));
    }
    throw new Error(`fake GitHub: no list route for ${path}`);
  };

  const post = async (path, body) => {
    state.calls.push({ method: 'POST', path, body });
    const url = new URL(path, 'https://api.github.test');
    let m;
    if ((m = /\/issues\/(\d+)\/comments$/.exec(url.pathname))) {
      const at = body.at ?? '2026-11-09T12:00:00Z';
      const comment = { id: (state.nextId += 1), body: body.body, user: BOT_USER, created_at: at, updated_at: at };
      (state.comments[m[1]] ??= []).push(comment);
      return comment;
    }
    if (/\/repos\/[^/]+\/[^/]+\/issues$/.test(url.pathname)) {
      const number = Math.max(0, ...state.issues.map((i) => i.number)) + 1;
      const issue = {
        number,
        title: body.title,
        body: body.body,
        labels: (body.labels ?? []).map((name) => ({ name })),
        state: 'open',
        user: BOT_USER,
        created_at: '2026-11-09T12:00:00Z',
      };
      state.issues.push(issue);
      return issue;
    }
    return {};
  };

  const patch = async (path, body) => {
    state.calls.push({ method: 'PATCH', path, body });
    const m = /\/issues\/(\d+)$/.exec(new URL(path, 'https://api.github.test').pathname);
    if (m) {
      const issue = state.issues.find((i) => i.number === Number(m[1]));
      if (issue) Object.assign(issue, body, body.state === 'closed' ? { closed_at: '2026-11-09T12:30:00Z' } : {});
    }
    return {};
  };

  const get = async (path) => {
    state.calls.push({ method: 'GET', path });
    const url = new URL(path, 'https://api.github.test');
    if (`GET ${url.pathname}` in routes) return routes[`GET ${url.pathname}`];
    let m;
    if ((m = /\/pulls\/(\d+)$/.exec(url.pathname))) return state.pulls.find((pr) => pr.number === Number(m[1])) ?? null;
    if ((m = /\/actions\/runs\/(\d+)$/.exec(url.pathname))) return state.runs[m[1]] ?? null;
    if ((m = /\/issues\/(\d+)$/.exec(url.pathname))) return state.issues.find((i) => i.number === Number(m[1])) ?? null;
    throw new Error(`fake GitHub: no get route for ${path}`);
  };

  return { list, post, patch, get, state, calls: state.calls };
}

export const posted = (client, suffix) =>
  client.calls.filter((c) => c.method === 'POST' && (!suffix || c.path.endsWith(suffix))).map((c) => c.body);
