// rest.ts — GitHub REST v3 under /api/v3: repositories, branches, commits, contents, labels,
// issues, comments and pull requests. Every reply is JSON and carries X-GitHub-Request-Id
// (added by app.ts); errors are JSON {"message": ...} with the statuses the suite asserts.

import {
  VIEWER_ID,
  VIEWER_LOGIN,
  commentJson,
  getFileAtTree,
  hashObject,
  isObjectId,
  issueJson,
  listTreeFiles,
  parseCommit,
  pullJson,
  repoJson,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResult {
  status: number;
  headers?: Record<string, string>;
  /** null body means "no body" (a 204). */
  body: unknown;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

const notFound = (message = 'Not Found'): RestResult => err(404, message);

function parseIntParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Paginate a list: the page's items plus a GitHub `Link` header (absolute URLs). */
function paginate<T>(
  items: readonly T[],
  query: URLSearchParams,
  baseUrl: string,
): { page: T[]; link: string | null } {
  const perPage = Math.min(100, Math.max(1, parseIntParam(query.get('per_page'), 30)));
  const page = Math.max(1, parseIntParam(query.get('page'), 1));
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const links: string[] = [];
  const urlFor = (p: number): string => `${baseUrl}?page=${p}&per_page=${perPage}`;
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  if (totalPages > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`);
    links.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  return { page: pageItems, link: links.length > 0 ? links.join(', ') : null };
}

/** The base URL for Link headers, from the request's Host header. */
function baseOf(host: string, path: string): string {
  return `http://${host}${path}`;
}

function repoOf(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

/** One commit as GitHub shapes it. */
function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const commit = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
  const authorLine = commit?.author ?? '';
  const match = /^(.*) (\d+) ([+-]\d{4})$/.exec(authorLine);
  const name = match?.[1]?.split('<')[0]?.trim() ?? VIEWER_LOGIN;
  const email = /<([^>]*)>/.exec(authorLine)?.[1] ?? '';
  const date = match?.[2] !== undefined ? new Date(Number(match[2]) * 1000).toISOString() : repo.createdAt;
  return {
    sha: oid,
    node_id: Buffer.from(`Commit:${repo.id}:${oid}`, 'utf8').toString('base64'),
    commit: {
      // Stored commit messages end with a newline; the API reports the message without it.
      message: (commit?.message ?? '').replace(/\n$/, ''),
      author: { name, email, date },
      committer: { name, email, date },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: (commit?.parents ?? []).map((parent) => ({ sha: parent })),
    tree: { sha: commit?.tree ?? '' },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
  };
}

/** Resolve a ref query (?ref= / ?sha=) to a commit oid: a branch name, a tag, or an oid. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return store_branchTip(repo, repo.defaultBranch);
  if (isObjectId(ref) && repo.objects.has(ref)) return ref;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return tag;
  return null;
}

function store_branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Handle a REST request. Returns null when the path is not a REST route (the caller answers
 * its JSON 404). `body` is the already-parsed JSON body (or null when there was none).
 */
export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  host: string,
): RestResult | null {
  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return ok(
      200,
      {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_url: '/api/v3/users/{username}',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return ok(200, {
      verifiable_password_authentication: true,
      installed_version: '1.0.0',
      git_sha: '0000000000000000000000000000000000000000',
    });
  }

  if (segments[0] === 'user') {
    if (segments.length === 1 && method === 'GET') {
      return ok(200, {
        login: VIEWER_LOGIN,
        id: VIEWER_ID,
        node_id: Buffer.from(`User:${VIEWER_ID}`, 'utf8').toString('base64'),
        type: 'User',
        name: 'ada iversen',
        email: 'adaiversen@example.invalid',
      });
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'GET') {
        const { page, link } = paginate(store.repoList, query, baseOf(host, '/api/v3/user/repos'));
        return ok(200, page.map((repo) => repoJson(repo)), link === null ? undefined : { link });
      }
      if (method === 'POST') {
        if (!isJson(body)) return err(400, 'request body must be a JSON object');
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
          return err(422, 'name is required and must be a valid repository name');
        }
        const repo = store.createRepo(name, {
          private: body.private === true,
          description: typeof body.description === 'string' ? body.description : '',
        });
        if (repo === null) return err(422, `Repository ${VIEWER_LOGIN}/${name} already exists`);
        return ok(201, repoJson(repo));
      }
      return notFound();
    }
    return null;
  }

  if (segments[0] !== 'repos' || segments.length < 3) return null;
  const owner = decodeURIComponent(segments[1] as string);
  const repoName = decodeURIComponent(segments[2] as string);
  const repo = repoOf(store, owner, repoName);
  if (repo === null) return notFound();
  const rest = segments.slice(3);
  const repoPath = `/api/v3/repos/${owner}/${repoName}`;

  // /repos/{o}/{r} itself.
  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoJson(repo));
    if (method === 'PATCH') {
      if (!isJson(body)) return err(400, 'request body must be a JSON object');
      if (typeof body.description === 'string') repo.description = body.description;
      return ok(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204, body: null };
    }
    return notFound();
  }

  // Branches.
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort();
      return ok(
        200,
        branches.map((name) => ({
          name,
          commit: { sha: repo.refs.get(`refs/heads/${name}`) ?? '' },
          protected: false,
        })),
      );
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = decodeURIComponent(rest[1] as string);
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) return notFound();
      return ok(200, { name: branch, commit: { sha: tip }, protected: false });
    }
    return notFound();
  }

  // Commits.
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const tip = resolveRef(repo, query.get('sha'));
    if (tip === null) return notFound();
    return ok(200, store.commitList(repo, tip).map((oid) => commitJson(repo, oid)));
  }

  // Git Data: refs.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    const refPath = rest.slice(2).map((segment) => decodeURIComponent(segment));
    if (method === 'GET' && refPath.length >= 2) {
      const refName = `refs/${refPath.join('/')}`;
      const oid = repo.refs.get(refName);
      if (oid === undefined) return notFound();
      return ok(200, { ref: refName, object: { sha: oid, type: 'commit', url: `${repoPath}/git/commits/${oid}` } });
    }
    if (method === 'GET' && refPath.length === 0) {
      return ok(
        200,
        [...repo.refs.entries()].map(([ref, oid]) => ({ ref, object: { sha: oid, type: 'commit' } })),
      );
    }
    if (method === 'POST' && refPath.length === 0) {
      if (!isJson(body)) return err(400, 'request body must be a JSON object');
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !isObjectId(sha) || !repo.objects.has(sha)) {
        return err(422, 'ref and sha are required and sha must name an object the repository holds');
      }
      if (repo.refs.has(ref)) return err(422, `Reference ${ref} already exists`);
      repo.refs.set(ref, sha);
      return ok(201, { ref, object: { sha, type: 'commit', url: `${repoPath}/git/commits/${sha}` } });
    }
    return notFound();
  }

  // Contents.
  if (rest[0] === 'contents') {
    const path = rest.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
    return handleContents(store, repo, method, path, query, body);
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return ok(
        200,
        [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description })),
      );
    }
    if (method === 'POST' && rest.length === 1) {
      if (!isJson(body)) return err(400, 'request body must be a JSON object');
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') return err(422, 'name is required');
      const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
      const description = typeof body.description === 'string' ? body.description : '';
      const existing = repo.labels.get(name);
      if (existing !== undefined) {
        existing.color = color;
        existing.description = description;
        return ok(201, { name, color, description });
      }
      repo.labels.set(name, { name, color, description });
      return ok(201, { name, color, description });
    }
    return notFound();
  }

  // Issues.
  if (rest[0] === 'issues') {
    return handleIssues(store, repo, method, rest.slice(1), query, body, host, repoPath);
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    return handlePulls(store, repo, method, rest.slice(1), query, body, repoPath);
  }

  return null;
}

function handleContents(
  store: Store,
  repo: Repo,
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): RestResult {
  const branch = (isJson(body) && typeof body.branch === 'string' ? body.branch : null) ?? query.get('ref') ?? repo.defaultBranch;
  if (method === 'GET') {
    const tip = resolveRef(repo, query.get('ref'));
    if (tip === null) return notFound();
    const tree = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
    if (path === '') {
      const entries = listTreeFiles(repo.objects, tree);
      const top = new Map<string, { type: string; sha: string }>();
      for (const file of entries) {
        const first = file.path.split('/')[0] as string;
        if (!top.has(first)) top.set(first, { type: 'file', sha: file.oid });
      }
      const treeEntries = repo.objects.get(tree) !== undefined ? parseTreeEntries(repo, tree) : [];
      for (const entry of treeEntries) {
        if (entry.mode === '40000') top.set(entry.name, { type: 'dir', sha: entry.oid });
      }
      return ok(
        200,
        [...top.entries()].map(([name, info]) => ({
          type: info.type,
          name,
          path: name,
          sha: info.sha,
          size: info.type === 'dir' ? 0 : 0,
        })),
      );
    }
    const file = getFileAtTree(repo.objects, tree, path);
    if (file !== null) {
      const name = path.split('/').pop() ?? path;
      return ok(200, {
        type: 'file',
        encoding: 'base64',
        size: file.data.length,
        name,
        path,
        sha: file.oid,
        content: file.data.toString('base64'),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      });
    }
    // A directory: the entries directly under it.
    const prefix = `${path}/`;
    const children = new Map<string, { type: string; sha: string; size: number }>();
    for (const entry of listTreeFiles(repo.objects, tree)) {
      if (!entry.path.startsWith(prefix)) continue;
      const rest = entry.path.slice(prefix.length);
      const first = rest.split('/')[0] as string;
      if (rest.includes('/')) {
        if (!children.has(first)) {
          const dirTree = findDirTree(repo, tree, path);
          children.set(first, { type: 'dir', sha: dirTree ?? '', size: 0 });
        }
      } else {
        children.set(first, { type: 'file', sha: entry.oid, size: repo.objects.get(entry.oid)?.data.length ?? 0 });
      }
    }
    if (children.size === 0) return notFound();
    return ok(
      200,
      [...children.entries()].map(([name, info]) => ({
        type: info.type,
        name,
        path: `${path}/${name}`,
        sha: info.sha,
        size: info.size,
      })),
    );
  }

  if (method === 'PUT') {
    if (path === '') return err(422, 'a file path is required');
    if (!isJson(body)) return err(400, 'request body must be a JSON object');
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Update ${path}`;
    const content = typeof body.content === 'string' ? Buffer.from(body.content, 'base64') : null;
    if (content === null) return err(422, 'content is required');
    const tip = resolveRef(repo, branch);
    const current = tip === null ? null : getFileAtTree(repo.objects, parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree, path);
    const expectedSha = typeof body.sha === 'string' ? body.sha : null;
    if (current !== null) {
      if (expectedSha === null) return err(422, 'sha is required to update a file');
      if (expectedSha.toLowerCase() !== current.oid.toLowerCase()) return err(409, 'sha does not match the current file');
    }
    const changes = new Map<string, Buffer | null>([[path, content]]);
    const { commitOid } = store.commitFiles(repo, branch, changes, message);
    const blobSha = hashObject('blob', content);
    return ok(current === null ? 201 : 200, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: blobSha,
        size: content.length,
        type: 'file',
        encoding: 'base64',
        content: content.toString('base64'),
      },
      commit: { sha: commitOid, message },
    });
  }

  if (method === 'DELETE') {
    if (path === '') return err(422, 'a file path is required');
    const tip = resolveRef(repo, branch);
    if (tip === null) return notFound();
    const tree = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
    const current = getFileAtTree(repo.objects, tree, path);
    if (current === null) return notFound();
    const expectedSha = isJson(body) && typeof body.sha === 'string' ? body.sha : null;
    if (expectedSha !== null && expectedSha.toLowerCase() !== current.oid.toLowerCase()) {
      return err(409, 'sha does not match the current file');
    }
    const message = isJson(body) && typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${path}`;
    const { commitOid } = store.commitFiles(repo, branch, new Map([[path, null]]), message);
    return ok(200, { commit: { sha: commitOid, message }, content: null });
  }

  return notFound();
}

function parseTreeEntries(repo: Repo, treeOid: string): Array<{ mode: string; name: string; oid: string }> {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  const data = object.data;
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    entries.push({ mode: data.subarray(offset, space).toString('ascii'), name: data.subarray(space + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    offset = nul + 21;
  }
  return entries;
}

function findDirTree(repo: Repo, rootTree: string, dirPath: string): string | null {
  let current = rootTree;
  for (const segment of dirPath.split('/').filter((part) => part !== '')) {
    const entry = parseTreeEntries(repo, current).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

function handleIssues(
  store: Store,
  repo: Repo,
  method: string,
  rest: string[],
  query: URLSearchParams,
  body: unknown,
  host: string,
  repoPath: string,
): RestResult {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const { page, link } = paginate(issues, query, baseOf(host, `${repoPath}/issues`));
      return ok(200, page.map((issue) => issueJson(repo, issue)), link === null ? undefined : { link });
    }
    if (method === 'POST') {
      if (!isJson(body)) return err(400, 'request body must be a JSON object');
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') return err(422, 'title is required');
      const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return err(422, `label "${label}" does not exist`);
      }
      const issue = store.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
      return ok(201, issueJson(repo, issue));
    }
    return notFound();
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number) || number < 1) return notFound();
  const issue: Issue | undefined = repo.issues.get(number);
  if (issue === undefined) return notFound();

  if (rest.length === 1) {
    if (method === 'GET') return ok(200, issueJson(repo, issue));
    if (method === 'PATCH') {
      if (!isJson(body)) return err(400, 'request body must be a JSON object');
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((label): label is string => typeof label === 'string');
        for (const label of labels) {
          if (!repo.labels.has(label)) return err(422, `label "${label}" does not exist`);
        }
        issue.labels = labels;
      }
      return ok(200, issueJson(repo, issue));
    }
    return notFound();
  }

  if (rest[1] === 'comments') {
    if (rest.length === 2 && method === 'GET') {
      return ok(200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
    }
    if (rest.length === 2 && method === 'POST') {
      if (!isJson(body)) return err(400, 'request body must be a JSON object');
      const text = typeof body.body === 'string' ? body.body : '';
      if (text === '') return err(422, 'body is required');
      const comment = store.createComment(repo, issue, text);
      return ok(201, commentJson(repo, issue, comment));
    }
    return notFound();
  }

  return null;
}

function handlePulls(
  store: Store,
  repo: Repo,
  method: string,
  rest: string[],
  query: URLSearchParams,
  body: unknown,
  repoPath: string,
): RestResult {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.seq - a.seq);
      const { page } = paginate(pulls, query, baseOf('localhost', `${repoPath}/pulls`));
      return ok(200, page.map((pull) => pullJson(repo, pull)));
    }
    if (method === 'POST') {
      if (!isJson(body)) return err(400, 'request body must be a JSON object');
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? body.head.split(':').pop() ?? '' : '';
      const base = typeof body.base === 'string' ? body.base.split(':').pop() ?? '' : '';
      if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
      if (store.branchTip(repo, head) === null) return err(422, `head branch "${head}" does not exist`);
      if (store.branchTip(repo, base) === null) return err(422, `base branch "${base}" does not exist`);
      const duplicate = [...repo.pulls.values()].find(
        (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
      );
      if (duplicate !== undefined) return err(422, 'a pull request from this head branch is already open');
      const pull = store.createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
      if (pull === null) return err(422, 'could not open the pull request');
      return ok(201, pullJson(repo, pull));
    }
    return notFound();
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isInteger(number) || number < 1) return notFound();
  const pull: PullRequest | undefined = repo.pulls.get(number);
  if (pull === undefined) return notFound();

  if (rest.length === 1) {
    if (method === 'GET') return ok(200, pullJson(repo, pull));
    return notFound();
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    return ok(
      200,
      store.pullRequestFiles(repo, pull).map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        sha: '',
        raw_url: '',
        blob_url: '',
        patch: '',
      })),
    );
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull.merged) return err(405, 'Pull request is already merged');
    const merged = store.mergePull(repo, pull);
    if (!merged.ok) return err(405, merged.reason === 'merge conflict' ? 'Merge conflict' : merged.reason);
    return ok(200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
  }
  return null;
}
