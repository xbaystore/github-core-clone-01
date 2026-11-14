// graphql.ts — GitHub GraphQL v4 at POST /api/graphql.
//
// A small hand-written executor for the documents gh and github-mcp-server actually send:
// viewer/repository/node reads, issue and pull-request connections with cursor pagination,
// the create/close/merge/comment mutations, __type introspection, and batched operation
// documents (a JSON array in one body). Unknown fields answer HTTP 200 with an `errors`
// array naming the field; an unknown repository is data.repository = null with no errors.

import {
  VIEWER_LOGIN,
  decodeGlobalId,
  diffTrees,
  findMergeBase,
  getFileAtTree,
  globalId,
  parseCommit,
  peelObject,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

// --------------------------------------------------------------------------- schema tables

const FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private',
    'url', 'createdAt', 'updatedAt',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels',
    'comments', 'repository',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'repository', 'author', 'createdAt', 'updatedAt', 'mergedAt',
    'mergeCommit',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  Label: ['id', 'name', 'color', 'description'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description', 'ofType', 'inputFields', 'interfaces', 'possibleTypes'],
  __Field: ['name', 'description', 'type', 'args'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['queryType', 'mutationType', 'types', 'directives'],
};

const ENUMS: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'WIKI', 'PACKAGE', 'MARKETPLACE', 'TOPIC'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

const TYPE_KIND: Readonly<Record<string, string>> = {
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  User: 'OBJECT',
  Repository: 'OBJECT',
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  IssueConnection: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PullRequestChangedFileConnection: 'OBJECT',
  PullRequestChangedFile: 'OBJECT',
  IssueCommentConnection: 'OBJECT',
  IssueComment: 'OBJECT',
  IssueCommentEdge: 'OBJECT',
  IssueEdge: 'OBJECT',
  PullRequestEdge: 'OBJECT',
  PullRequestChangedFileEdge: 'OBJECT',
  PageInfo: 'OBJECT',
  Ref: 'OBJECT',
  Label: 'OBJECT',
  CreateIssuePayload: 'OBJECT',
  CloseIssuePayload: 'OBJECT',
  CreatePullRequestPayload: 'OBJECT',
  MergePullRequestPayload: 'OBJECT',
  AddCommentPayload: 'OBJECT',
  __Type: 'OBJECT',
  __Field: 'OBJECT',
  __EnumValue: 'OBJECT',
  __InputValue: 'OBJECT',
  __Schema: 'OBJECT',
};

// --------------------------------------------------------------------------- parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index] as string;
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ',') {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < input.length && input[index] !== '\n') index += 1;
      continue;
    }
    if (char === '.' && input.slice(index, index + 3) === '...') {
      tokens.push({ kind: 'spread' });
      index += 3;
      continue;
    }
    if ('{}()[]:!=$@|&'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      index += 1;
      continue;
    }
    if (char === '"') {
      let value = '';
      index += 1;
      while (index < input.length && input[index] !== '"') {
        const c = input[index] as string;
        if (c === '\\' && index + 1 < input.length) {
          const escaped = input[index + 1] as string;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          index += 2;
        } else {
          value += c;
          index += 1;
        }
      }
      index += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      let end = index;
      while (end < input.length && /[0-9.eE+-]/.test(input[end] as string)) end += 1;
      const text = input.slice(index, end);
      tokens.push(/[.eE]/.test(text) ? { kind: 'float', value: text } : { kind: 'int', value: text });
      index = end;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index;
      while (end < input.length && /[A-Za-z0-9_]/.test(input[end] as string)) end += 1;
      tokens.push({ kind: 'name', value: input.slice(index, end) });
      index = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)} in GraphQL document`);
  }
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldSelection {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selections: Selection[];
}

interface FragmentSelection {
  kind: 'fragment';
  typeCondition: string | null;
  selections: Selection[];
}

interface SpreadSelection {
  kind: 'spread';
  name: string;
}

type Selection = FieldSelection | FragmentSelection | SpreadSelection;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string; required: boolean; defaultValue: ValueNode | null }>;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selections: Selection[] }>;
}

class Parser {
  private tokens: Token[];
  private index = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.index += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}" in GraphQL document`);
    }
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        this.parseArguments();
      }
    }
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selections: Selection[] }>();
    while (this.peek() !== undefined) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          type: 'query',
          name: null,
          variables: [],
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const type = token.value as 'query' | 'mutation';
        this.next();
        let name: string | null = null;
        const nextToken = this.peek();
        if (nextToken !== undefined && nextToken.kind === 'name') name = this.next().value as string;
        const variables: Operation['variables'] = [];
        if (this.matchPunct('(')) {
          while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            const varType = this.parseType();
            let defaultValue: ValueNode | null = null;
            if (this.matchPunct('=')) defaultValue = this.parseValue();
            variables.push({ name: varName, type: varType.text, required: varType.required, defaultValue });
          }
          this.expectPunct(')');
        }
        this.skipDirectives();
        operations.push({ type, name, variables, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token in GraphQL document: ${JSON.stringify(token)}`);
    }
    return { operations, fragments };
  }

  private parseType(): { text: string; required: boolean } {
    let required = false;
    let text: string;
    if (this.matchPunct('[')) {
      const inner = this.parseType();
      this.expectPunct(']');
      text = `[${inner.text}]`;
    } else {
      text = this.expectName();
    }
    if (this.matchPunct('!')) {
      required = true;
      text = `${text}!`;
    }
    return { text, required };
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek() as Token;
    if (token.kind === 'spread') {
      this.next();
      const nextToken = this.peek();
      if (nextToken !== undefined && nextToken.kind === 'name' && nextToken.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (nextToken !== undefined && nextToken.kind === 'name') {
        const name = this.next().value as string;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'fragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(' ? this.parseArguments() : [];
    this.skipDirectives();
    const selections =
      this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// --------------------------------------------------------------------------- execution

type GqlValue = Record<string, unknown> & { __type: string };

interface Ctx {
  store: Store;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'enum':
      return node.value;
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function evalArgs(args: Array<{ name: string; value: ValueNode }>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = evalValue(arg.value, variables);
  return out;
}

function userValue(login: string): GqlValue {
  return { __type: 'User', login, id: globalId('User', login === VIEWER_LOGIN ? 1000 : 0), name: login === VIEWER_LOGIN ? 'ada iversen' : login, email: `${login}@example.invalid` };
}

function refValue(name: string): GqlValue {
  return { __type: 'Ref', name };
}

function repoValue(repo: Repo): GqlValue {
  return { __type: 'Repository', repo };
}

function issueValue(repo: Repo, issue: Issue): GqlValue {
  return { __type: 'Issue', repo, issue };
}

function pullValue(repo: Repo, pull: PullRequest): GqlValue {
  return { __type: 'PullRequest', repo, pull };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1] as string, 10);
  } catch {
    return null;
  }
}

/** The issues connection for a repository, filtered, ordered and paged. */
function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const first = typeof args.first === 'number' ? args.first : 100;
  const after = numberFromCursor(args.after);
  let issues = [...repo.issues.values()];
  if (states !== null) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    issues = issues.filter((issue) => wanted.has(issue.state.toUpperCase()));
  }
  const direction = String(orderBy.direction ?? 'DESC').toUpperCase() === 'ASC' ? 1 : -1;
  const field = String(orderBy.field ?? 'CREATED_AT').toUpperCase();
  issues.sort((a, b) => {
    let primary = 0;
    if (field === 'COMMENTS') primary = a.comments.length - b.comments.length;
    else primary = a.seq - b.seq;
    if (primary !== 0) return primary * direction;
    return (a.number - b.number) * direction;
  });
  let start = 0;
  if (after !== null) {
    const index = issues.findIndex((issue) => issue.number === after);
    start = index >= 0 ? index + 1 : 0;
  }
  const page = issues.slice(start, start + first);
  const hasNextPage = start + page.length < issues.length;
  const endCursor = page.length > 0 ? cursorFor((page[page.length - 1] as Issue).number) : null;
  return {
    __type: 'IssueConnection',
    nodes: page.map((issue) => issueValue(repo, issue)),
    edges: page.map((issue) => ({ __type: 'IssueEdge', node: issueValue(repo, issue), cursor: cursorFor(issue.number) })),
    pageInfo: { __type: 'PageInfo', hasNextPage, hasPreviousPage: start > 0, startCursor: page.length > 0 ? cursorFor((page[0] as Issue).number) : null, endCursor },
    totalCount: issues.length,
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
  const first = typeof args.first === 'number' ? args.first : 100;
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let pulls = [...repo.pulls.values()];
  if (states !== null) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    pulls = pulls.filter((pull) => wanted.has(pull.state.toUpperCase()));
  } else {
    pulls = pulls.filter((pull) => pull.state === 'open');
  }
  pulls.sort((a, b) => b.seq - a.seq);
  const page = pulls.slice(0, first);
  return {
    __type: 'PullRequestConnection',
    nodes: page.map((pull) => pullValue(repo, pull)),
    edges: page.map((pull) => ({ __type: 'PullRequestEdge', node: pullValue(repo, pull), cursor: cursorFor(pull.number) })),
    pageInfo: { __type: 'PageInfo', hasNextPage: page.length < pulls.length, hasPreviousPage: false, startCursor: null, endCursor: null },
    totalCount: pulls.length,
  };
}

/** Whether merging this pull request would conflict (the merge check, without applying it). */
function mergeableOf(repo: Repo, pull: PullRequest): string {
  if (pull.merged) return 'UNKNOWN';
  const mergeBase = findMergeBase(repo.objects, pull.headSha, pull.baseSha);
  if (mergeBase === null) return 'UNKNOWN';
  const baseTree = parseCommit(repo.objects.get(mergeBase)?.data ?? Buffer.alloc(0)).tree;
  const headTree = parseCommit(repo.objects.get(pull.headSha)?.data ?? Buffer.alloc(0)).tree;
  const currentTree = parseCommit(repo.objects.get(pull.baseSha)?.data ?? Buffer.alloc(0)).tree;
  for (const change of diffTrees(repo.objects, baseTree, headTree)) {
    const baseVersion = getFileAtTree(repo.objects, baseTree, change.path);
    const currentVersion = getFileAtTree(repo.objects, currentTree, change.path);
    const headVersion = getFileAtTree(repo.objects, headTree, change.path);
    const baseOid = baseVersion?.oid ?? null;
    const currentOid = currentVersion?.oid ?? null;
    const headOid = headVersion?.oid ?? null;
    if (currentOid !== baseOid && headOid !== currentOid && headOid !== baseOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function resolveField(ctx: Ctx, parent: GqlValue, field: string, args: Record<string, unknown>): unknown {
  const type = parent.__type;
  switch (type) {
    case 'Query': {
      if (field === 'viewer') return userValue(VIEWER_LOGIN);
      if (field === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        if (owner !== VIEWER_LOGIN) return null;
        const repo = ctx.store.getRepo(owner, name);
        return repo === undefined ? null : repoValue(repo);
      }
      if (field === 'node') {
        const id = String(args.id ?? '');
        const resolved = ctx.store.resolveGlobalId(id);
        if (resolved === null) return null;
        if (resolved.pull !== undefined) return pullValue(resolved.repo, resolved.pull);
        if (resolved.issue !== undefined) return issueValue(resolved.repo, resolved.issue);
        return repoValue(resolved.repo);
      }
      if (field === '__type') {
        const name = String(args.name ?? '');
        return typeInfo(name);
      }
      if (field === '__schema') {
        return { __type: '__Schema', queryType: { __type: '__Type', name: 'Query', kind: 'OBJECT' }, mutationType: { __type: '__Type', name: 'Mutation', kind: 'OBJECT' }, types: [], directives: [] };
      }
      return undefined;
    }
    case 'Mutation': {
      if (field === 'createIssue') return createIssueMutation(ctx, args);
      if (field === 'closeIssue') return closeIssueMutation(ctx, args);
      if (field === 'createPullRequest') return createPullRequestMutation(ctx, args);
      if (field === 'mergePullRequest') return mergePullRequestMutation(ctx, args);
      if (field === 'addComment') return addCommentMutation(ctx, args);
      return undefined;
    }
    case 'User': {
      if (field === 'id') return parent.id as string;
      if (field === 'login') return parent.login as string;
      if (field === 'name') return parent.name as string;
      if (field === 'email') return parent.email as string;
      if (field === 'avatarUrl') return '';
      if (field === 'url') return `https://example.invalid/${parent.login as string}`;
      return undefined;
    }
    case 'Repository': {
      const repo = parent.repo as Repo;
      if (field === 'id') return globalId('Repository', repo.id);
      if (field === 'databaseId') return repo.id;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return repo.fullName;
      if (field === 'owner') return userValue(repo.owner);
      if (field === 'defaultBranchRef') return refValue(repo.defaultBranch);
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'description') return repo.description;
      if (field === 'private') return repo.private;
      if (field === 'url') return `https://example.invalid/${repo.fullName}`;
      if (field === 'createdAt' || field === 'updatedAt') return repo.createdAt;
      if (field === 'issue') {
        const issue = repo.issues.get(Number(args.number));
        return issue === undefined ? null : issueValue(repo, issue);
      }
      if (field === 'issues') return issuesConnection(repo, args);
      if (field === 'pullRequests') return pullsConnection(repo, args);
      if (field === 'pullRequest') {
        const pull = repo.pulls.get(Number(args.number));
        return pull === undefined ? null : pullValue(repo, pull);
      }
      return undefined;
    }
    case 'Issue': {
      const repo = parent.repo as Repo;
      const issue = parent.issue as Issue;
      if (field === 'id') return globalId('Issue', repo.id, issue.number);
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'state') return issue.state.toUpperCase();
      if (field === 'body') return issue.body;
      if (field === 'url') return `https://example.invalid/${repo.fullName}/issues/${issue.number}`;
      if (field === 'createdAt') return issue.createdAt;
      if (field === 'updatedAt') return issue.updatedAt;
      if (field === 'author') return userValue(VIEWER_LOGIN);
      if (field === 'repository') return repoValue(repo);
      if (field === 'labels') {
        return issue.labels.map((name) => {
          const label = repo.labels.get(name);
          return { __type: 'Label', id: globalId('Label', repo.id, name), name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
        });
      }
      if (field === 'comments') {
        return {
          __type: 'IssueCommentConnection',
          nodes: issue.comments.map((comment) => ({ __type: 'IssueComment', repo, issue, comment })),
          edges: issue.comments.map((comment) => ({ __type: 'IssueCommentEdge', node: { __type: 'IssueComment', repo, issue, comment }, cursor: cursorFor(comment.id) })),
          pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
          totalCount: issue.comments.length,
        };
      }
      return undefined;
    }
    case 'PullRequest': {
      const repo = parent.repo as Repo;
      const pull = parent.pull as PullRequest;
      if (field === 'id') return globalId('PullRequest', repo.id, pull.number);
      if (field === 'number') return pull.number;
      if (field === 'title') return pull.title;
      if (field === 'body') return pull.body;
      if (field === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      if (field === 'merged') return pull.merged;
      if (field === 'mergeable') return mergeableOf(repo, pull);
      if (field === 'headRefName') return pull.headRef;
      if (field === 'baseRefName') return pull.baseRef;
      if (field === 'headRef') return refValue(pull.headRef);
      if (field === 'baseRef') return refValue(pull.baseRef);
      if (field === 'repository') return repoValue(repo);
      if (field === 'author') return userValue(VIEWER_LOGIN);
      if (field === 'createdAt') return pull.createdAt;
      if (field === 'updatedAt') return pull.updatedAt;
      if (field === 'mergedAt') return pull.mergedAt;
      if (field === 'mergeCommit') return pull.mergeCommitSha === null ? null : { __type: 'Commit', oid: pull.mergeCommitSha };
      if (field === 'files') {
        const first = typeof args.first === 'number' ? args.first : 100;
        const files = ctx.store.pullRequestFiles(repo, pull).slice(0, first);
        return {
          __type: 'PullRequestChangedFileConnection',
          nodes: files.map((file) => ({ __type: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() })),
          edges: files.map((file) => ({ __type: 'PullRequestChangedFileEdge', node: { __type: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() }, cursor: cursorFor(file.filename.length) })),
          pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
          totalCount: files.length,
        };
      }
      return undefined;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'IssueCommentConnection': {
      if (field === 'nodes' || field === 'edges' || field === 'pageInfo' || field === 'totalCount') {
        return (parent as unknown as Record<string, unknown>)[field];
      }
      return undefined;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestChangedFileEdge':
    case 'IssueCommentEdge': {
      if (field === 'node' || field === 'cursor') return (parent as unknown as Record<string, unknown>)[field];
      return undefined;
    }
    case 'PageInfo': {
      if (field === 'hasNextPage' || field === 'hasPreviousPage' || field === 'startCursor' || field === 'endCursor') {
        return (parent as unknown as Record<string, unknown>)[field] ?? null;
      }
      return undefined;
    }
    case 'Ref': {
      if (field === 'name') return parent.name as string;
      if (field === 'target') return null;
      return undefined;
    }
    case 'Label': {
      if (field === 'id' || field === 'name' || field === 'color' || field === 'description') {
        return (parent as unknown as Record<string, unknown>)[field];
      }
      return undefined;
    }
    case 'PullRequestChangedFile': {
      if (field === 'path' || field === 'additions' || field === 'deletions' || field === 'changeType') {
        return (parent as unknown as Record<string, unknown>)[field];
      }
      return undefined;
    }
    case 'IssueComment': {
      const repo = parent.repo as Repo;
      const issue = parent.issue as Issue;
      const comment = parent.comment as { id: number; body: string; createdAt: string };
      if (field === 'id') return globalId('IssueComment', repo.id, issue.number, comment.id);
      if (field === 'body') return comment.body;
      if (field === 'author') return userValue(VIEWER_LOGIN);
      if (field === 'createdAt' || field === 'updatedAt') return comment.createdAt;
      return undefined;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field === 'issue') return (parent as unknown as Record<string, unknown>).issue;
      if (field === 'clientMutationId') return null;
      return undefined;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field === 'pullRequest') return (parent as unknown as Record<string, unknown>).pullRequest;
      if (field === 'clientMutationId') return null;
      return undefined;
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return (parent as unknown as Record<string, unknown>).commentEdge;
      if (field === 'clientMutationId') return null;
      return undefined;
    }
    case '__Type': {
      if (field === 'name') return parent.name as string;
      if (field === 'kind') return parent.kind as string;
      if (field === 'description') return null;
      if (field === 'fields') {
        const names = (parent.fields as string[] | null) ?? null;
        if (names === null) return null;
        return names.map((name) => ({ __type: '__Field', name }));
      }
      if (field === 'enumValues') {
        const names = (parent.enumValues as string[] | null) ?? null;
        if (names === null) return null;
        return names.map((name) => ({ __type: '__EnumValue', name }));
      }
      if (field === 'ofType' || field === 'inputFields' || field === 'interfaces' || field === 'possibleTypes') return null;
      return undefined;
    }
    case '__Field': {
      if (field === 'name') return parent.name as string;
      if (field === 'description') return null;
      if (field === 'type') return { __type: '__Type', name: 'String', kind: 'SCALAR' };
      if (field === 'args') return [];
      return undefined;
    }
    case '__EnumValue': {
      if (field === 'name') return parent.name as string;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      return undefined;
    }
    case '__Schema': {
      if (field === 'queryType' || field === 'mutationType') return (parent as unknown as Record<string, unknown>)[field];
      if (field === 'types' || field === 'directives') return [];
      return undefined;
    }
    case 'Commit': {
      if (field === 'oid') return (parent as unknown as Record<string, unknown>).oid;
      return undefined;
    }
    default:
      return undefined;
  }
}

/** The __Type value for a named type, or null when the schema does not hold it. */
function typeInfo(name: string): GqlValue | null {
  if (FIELDS[name] !== undefined) {
    return { __type: '__Type', name, kind: TYPE_KIND[name] ?? 'OBJECT', fields: [...FIELDS[name]], enumValues: null };
  }
  if (ENUMS[name] !== undefined) {
    return { __type: '__Type', name, kind: 'ENUM', fields: null, enumValues: [...ENUMS[name]] };
  }
  return null;
}

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function createIssueMutation(ctx: Ctx, args: Record<string, unknown>): unknown {
  const input = inputOf(args);
  const resolved = ctx.store.resolveGlobalId(String(input.repositoryId ?? ''));
  if (resolved === null) {
    ctx.errors.push({ message: `repository ${String(input.repositoryId ?? '')} does not exist` });
    return null;
  }
  const title = String(input.title ?? '');
  if (title === '') {
    ctx.errors.push({ message: 'createIssue requires a title' });
    return null;
  }
  const issue = ctx.store.createIssue(resolved.repo, title, typeof input.body === 'string' ? input.body : '', []);
  return { __type: 'CreateIssuePayload', issue: issueValue(resolved.repo, issue) };
}

function closeIssueMutation(ctx: Ctx, args: Record<string, unknown>): unknown {
  const input = inputOf(args);
  const resolved = ctx.store.resolveGlobalId(String(input.issueId ?? ''));
  if (resolved === null || resolved.issue === undefined) {
    ctx.errors.push({ message: `issue ${String(input.issueId ?? '')} does not exist` });
    return null;
  }
  resolved.issue.state = 'closed';
  return { __type: 'CloseIssuePayload', issue: issueValue(resolved.repo, resolved.issue) };
}

function createPullRequestMutation(ctx: Ctx, args: Record<string, unknown>): unknown {
  const input = inputOf(args);
  const resolved = ctx.store.resolveGlobalId(String(input.repositoryId ?? ''));
  if (resolved === null) {
    ctx.errors.push({ message: `repository ${String(input.repositoryId ?? '')} does not exist` });
    return null;
  }
  const head = String(input.headRefName ?? '');
  const base = String(input.baseRefName ?? '');
  const title = String(input.title ?? '');
  if (ctx.store.branchTip(resolved.repo, head) === null) {
    ctx.errors.push({ message: `head branch ${head} does not exist` });
    return null;
  }
  const pull = ctx.store.createPull(resolved.repo, title, typeof input.body === 'string' ? input.body : '', head, base);
  if (pull === null) {
    ctx.errors.push({ message: `could not open a pull request from ${head} into ${base}` });
    return null;
  }
  return { __type: 'CreatePullRequestPayload', pullRequest: pullValue(resolved.repo, pull) };
}

function mergePullRequestMutation(ctx: Ctx, args: Record<string, unknown>): unknown {
  const input = inputOf(args);
  const resolved = ctx.store.resolveGlobalId(String(input.pullRequestId ?? ''));
  if (resolved === null || resolved.pull === undefined) {
    ctx.errors.push({ message: `pull request ${String(input.pullRequestId ?? '')} does not exist` });
    return null;
  }
  const merged = ctx.store.mergePull(resolved.repo, resolved.pull);
  if (!merged.ok) {
    ctx.errors.push({ message: `merge failed: ${merged.reason}` });
    return null;
  }
  return { __type: 'MergePullRequestPayload', pullRequest: pullValue(resolved.repo, resolved.pull) };
}

function addCommentMutation(ctx: Ctx, args: Record<string, unknown>): unknown {
  const input = inputOf(args);
  const resolved = ctx.store.resolveGlobalId(String(input.subjectId ?? ''));
  if (resolved === null || resolved.issue === undefined) {
    ctx.errors.push({ message: `subject ${String(input.subjectId ?? '')} does not exist` });
    return null;
  }
  const body = typeof input.body === 'string' ? input.body : '';
  const comment = ctx.store.createComment(resolved.repo, resolved.issue, body);
  const node = { __type: 'IssueComment', repo: resolved.repo, issue: resolved.issue, comment };
  return { __type: 'AddCommentPayload', commentEdge: { __type: 'IssueCommentEdge', node, cursor: cursorFor(comment.id) } };
}

// --------------------------------------------------------------------------- selection execution

function executeSelections(
  ctx: Ctx,
  parent: GqlValue,
  selections: Selection[],
  variables: Record<string, unknown>,
  document: Document,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const parentType = parent.__type;
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parentType) continue;
      Object.assign(out, executeSelections(ctx, parent, selection.selections, variables, document));
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = document.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition !== parentType) continue;
      Object.assign(out, executeSelections(ctx, parent, fragment.selections, variables, document));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[responseKey] = parentType;
      continue;
    }
    const known = FIELDS[parentType];
    if (known !== undefined && !known.includes(selection.name) && selection.name !== '__type' && selection.name !== '__schema') {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".` });
      out[responseKey] = null;
      continue;
    }
    const args = evalArgs(selection.args, variables);
    const value = resolveField(ctx, parent, selection.name, args);
    out[responseKey] = resolveValue(ctx, value, selection.selections, variables, document);
  }
  return out;
}

function resolveValue(
  ctx: Ctx,
  value: unknown,
  selections: Selection[],
  variables: Record<string, unknown>,
  document: Document,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => resolveValue(ctx, entry, selections, variables, document));
  }
  if (typeof value === 'object' && (value as GqlValue).__type !== undefined) {
    if (selections.length === 0) return {};
    return executeSelections(ctx, value as GqlValue, selections, variables, document);
  }
  return value;
}

function executeOperation(
  store: Store,
  document: Document,
  operation: Operation,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const ctx: Ctx = { store, errors: [] };
  for (const variable of operation.variables) {
    const provided = variables[variable.name];
    if (provided === undefined) {
      if (variable.defaultValue !== null) variables[variable.name] = evalValue(variable.defaultValue, variables);
      else if (variable.required) {
        ctx.errors.push({ message: `Variable $${variable.name} of required type ${variable.type} was not provided.` });
        return { data: null, errors: ctx.errors };
      }
    }
  }
  const root: GqlValue = { __type: operation.type === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelections(ctx, root, operation.selections, variables, document);
  return { data, errors: ctx.errors };
}

/**
 * Handle one GraphQL HTTP body (an object or an array of operation documents).
 * Returns the HTTP status and the JSON body to send.
 */
export function handleGraphQL(store: Store, body: unknown): { status: number; body: unknown } {
  const runOne = (operationBody: unknown): Record<string, unknown> => {
    if (typeof operationBody !== 'object' || operationBody === null || Array.isArray(operationBody)) {
      return { errors: [{ message: 'a GraphQL operation must be a JSON object with a query string' }] };
    }
    const record = operationBody as Record<string, unknown>;
    const query = record.query;
    if (typeof query !== 'string' || query.trim() === '') {
      return { errors: [{ message: 'a GraphQL operation needs a query string' }] };
    }
    let document: Document;
    try {
      document = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    const operation =
      document.operations.find((candidate) => operationName !== null && candidate.name === operationName) ??
      document.operations[0];
    if (operation === undefined) return { errors: [{ message: 'the document holds no operation' }] };
    const result = executeOperation(store, document, operation, { ...variables });
    if (result.errors.length > 0) return { data: result.data, errors: result.errors };
    return { data: result.data };
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => runOne(entry)) };
  }
  return { status: 200, body: runOne(body) };
}
