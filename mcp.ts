// mcp.ts — Model Context Protocol endpoint at POST /mcp.
//
// JSON-RPC 2.0 over Streamable HTTP. Supports the modern revision 2026-07-28
// (server/discover, followed by a tools/list + tools/call session) and the legacy
// initialize / notifications/initialized handshake as a fallback. Tools act on the
// same in-memory store as the REST and GraphQL surfaces.

import { VIEWER_LOGIN, type Store } from './store.ts';

export const MCP_REVISION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'number', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(data: unknown, isError = false): Record<string, unknown> {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return {
    content: [{ type: 'text', text }],
    structuredContent: typeof data === 'object' && data !== null ? data : { result: data },
    isError,
  };
}

function firstString(args: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

function firstNumber(args: Record<string, unknown>, names: string[]): number | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return toolResult({ error: `unknown tool ${name}` }, true);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolResult({ error: `missing required argument ${required}` }, true);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = firstString(args, ['name']) as string;
      const description = firstString(args, ['description']) ?? '';
      const isPrivate = args.private === true;
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) {
        return toolResult({ error: `repository ${VIEWER_LOGIN}/${repoName} already exists` }, true);
      }
      const repo = store.createRepo(repoName, { private: isPrivate, description });
      return toolResult({ full_name: repo.fullName, name: repo.name, owner: { login: repo.owner }, description: repo.description, private: repo.private, default_branch: repo.defaultBranch });
    }
    case 'get_repo': {
      const owner = firstString(args, ['owner', 'owner_login']) as string;
      const repoName = firstString(args, ['repo', 'repository', 'name']) as string;
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolResult({ error: `repository ${owner}/${repoName} not found` }, true);
      return toolResult({ full_name: repo.fullName, name: repo.name, owner: { login: repo.owner }, description: repo.description, private: repo.private, default_branch: repo.defaultBranch });
    }
    case 'create_issue': {
      const owner = firstString(args, ['owner', 'owner_login']) as string;
      const repoName = firstString(args, ['repo', 'repository', 'name']) as string;
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolResult({ error: `repository ${owner}/${repoName} not found` }, true);
      const title = firstString(args, ['title']) as string;
      const issue = store.createIssue(repo, title, firstString(args, ['body']) ?? '', []);
      return toolResult({ number: issue.number, id: issue.id, title: issue.title, body: issue.body, state: issue.state, url: `https://example.invalid/${repo.fullName}/issues/${issue.number}` });
    }
    case 'list_issues': {
      const owner = firstString(args, ['owner', 'owner_login']) as string;
      const repoName = firstString(args, ['repo', 'repository', 'name']) as string;
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolResult({ error: `repository ${owner}/${repoName} not found` }, true);
      const state = firstString(args, ['state']) ?? 'open';
      const issues = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
      return toolResult({ issues: issues.map((issue) => ({ number: issue.number, id: issue.id, title: issue.title, body: issue.body, state: issue.state })) });
    }
    case 'get_issue': {
      const owner = firstString(args, ['owner', 'owner_login']) as string;
      const repoName = firstString(args, ['repo', 'repository', 'name']) as string;
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolResult({ error: `repository ${owner}/${repoName} not found` }, true);
      const number = firstNumber(args, ['issue_number', 'number']) as number;
      const issue = repo.issues.get(number);
      if (issue === undefined) return toolResult({ error: `issue #${number} not found` }, true);
      return toolResult({ number: issue.number, id: issue.id, title: issue.title, body: issue.body, state: issue.state, url: `https://example.invalid/${repo.fullName}/issues/${issue.number}` });
    }
    case 'create_pull_request': {
      const owner = firstString(args, ['owner', 'owner_login']) as string;
      const repoName = firstString(args, ['repo', 'repository', 'name']) as string;
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolResult({ error: `repository ${owner}/${repoName} not found` }, true);
      const head = firstString(args, ['head', 'head_branch']) as string;
      const base = firstString(args, ['base', 'base_branch']) as string;
      const title = firstString(args, ['title']) as string;
      if (store.branchTip(repo, head) === null) return toolResult({ error: `head branch ${head} does not exist` }, true);
      const pull = store.createPull(repo, title, firstString(args, ['body']) ?? '', head, base);
      if (pull === null) return toolResult({ error: `could not open a pull request from ${head} into ${base}` }, true);
      return toolResult({ number: pull.number, id: pull.id, title: pull.title, body: pull.body, state: pull.state, head: { ref: pull.headRef, sha: pull.headSha }, base: { ref: pull.baseRef, sha: pull.baseSha } });
    }
    case 'merge_pull_request': {
      const owner = firstString(args, ['owner', 'owner_login']) as string;
      const repoName = firstString(args, ['repo', 'repository', 'name']) as string;
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolResult({ error: `repository ${owner}/${repoName} not found` }, true);
      const number = firstNumber(args, ['pull_number', 'number']) as number;
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolResult({ error: `pull request #${number} not found` }, true);
      const merged = store.mergePull(repo, pull);
      if (!merged.ok) return toolResult({ error: `merge failed: ${merged.reason}` }, true);
      return toolResult({ merged: true, sha: pull.mergeCommitSha, message: 'Pull request successfully merged' });
    }
    default:
      return toolResult({ error: `unknown tool ${name}` }, true);
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Handle one POST /mcp body. `body` is the already-parsed JSON (or undefined when
 * the request body was not valid JSON). Returns the HTTP status and JSON body.
 */
export function handleMcp(store: Store, body: unknown): { status: number; body: unknown } {
  if (body === undefined) {
    return { status: 400, body: rpcError(null, -32700, 'Parse error: request body is not valid JSON') };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object') };
  }
  const request = body as Record<string, unknown>;
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        supportedVersions: [MCP_REVISION, '2025-06-18'],
        protocolVersion: MCP_REVISION,
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-forge', version: '0.1.0' },
        instructions: 'A git forge with repositories, issues and pull requests.',
      }),
    };
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_REVISION;
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: offered,
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-forge', version: '0.1.0' },
      }),
    };
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return { status: 202, body: null };
  }
  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }
  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (name === '') return { status: 200, body: rpcError(id, -32602, 'tools/call requires a tool name') };
    const known = TOOLS.some((tool) => tool.name === name);
    if (!known) return { status: 200, body: rpcError(id, -32601, `Method not found: tool ${name}`) };
    return { status: 200, body: rpcResult(id, callTool(store, name, args)) };
  }
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
