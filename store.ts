// store.ts — the forge's single in-memory store, shared by git, REST, GraphQL and MCP.
//
// Everything the four surfaces serve lives here: repositories, their git object stores and refs,
// issues, pull requests, labels and comments. One Store instance is created per process; the
// trial's suite is its only client, so a process-global store is the whole database.
//
// Determinism: no wall clock and no unseeded randomness reach any stored value. Timestamps come
// from MAKEFUN_TRIAL_NOW plus a monotonic counter, so the same request order always builds the
// same bytes (and the same commit ids) on the live pass and on a replay.

import { createHash } from 'node:crypto';

/** The login the bearer token names (the seeded scenario's viewer; fixed by the public kit). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;
export const DEFAULT_BRANCH = 'main';
export const ZERO_OID = '0'.repeat(40);

/** The bearer token this process was given (empty outside a trial: any non-empty Bearer passes). */
export const EXPECTED_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** True when the Authorization header carries the trial's token. */
export function isAuthorized(authHeader: string | undefined): boolean {
  if (authHeader === undefined) return false;
  const match = /^Bearer (.+)$/.exec(authHeader);
  if (match === null) return false;
  const token = match[1] ?? '';
  if (token === '') return false;
  if (EXPECTED_TOKEN === '') return true;
  return token === EXPECTED_TOKEN;
}

// --------------------------------------------------------------------------- deterministic clock

const TRIAL_NOW_SEC: number = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const ms = Date.parse(raw);
  if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  return 1794604200; // 2026-11-14T06:30:00Z, the competition's opening
})();

let clockSeq = 0;

/** The next timestamp: the trial's now plus a monotonic second, as epoch seconds and ISO text. */
export function nextTimestamp(): { epochSec: number; iso: string } {
  clockSeq += 1;
  const epochSec = TRIAL_NOW_SEC + clockSeq;
  return { epochSec, iso: new Date(epochSec * 1000).toISOString() };
}

let orderSeq = 0;

/** A monotonic sequence number for creation ordering (issues, pulls, comments, repos). */
export function nextOrder(): number {
  orderSeq += 1;
  return orderSeq;
}

// --------------------------------------------------------------------------- git objects

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object, returning its id. */
export function putObject(objects: Map<string, GitObject>, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries (sorted the way git sorts them). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp: number;
}): Buffer {
  const who = `${fields.author ?? `${VIEWER_NAME} <${VIEWER_EMAIL}>`} ${fields.timestamp} +0000`;
  const committer = `${fields.committer ?? `${VIEWER_NAME} <${VIEWER_EMAIL}>`} ${fields.timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Every object reachable from `roots`: commit -> tree + parents, tree -> entries, tag -> target. */
export function collectReachable(objects: Map<string, GitObject>, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` through parent links (or equal to it). */
export function isAncestor(objects: Map<string, GitObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The nearest common ancestor of two commits (breadth-first from both sides), or null. */
export function findMergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.shift() as string;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const oid = queueB.shift() as string;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

/** Peel a tag (recursively) to the non-tag object it names. */
export function peelObject(objects: Map<string, GitObject>, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// --------------------------------------------------------------------------- tree helpers

export interface FileEntry {
  path: string;
  oid: string;
  mode: string;
}

/** All files under a tree, flattened to full paths. */
export function listTreeFiles(objects: Map<string, GitObject>, treeOid: string): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (oid: string, prefix: string): void => {
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.push({ path, oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** The blob at `path` in the tree, or null. */
export function getFileAtTree(
  objects: Map<string, GitObject>,
  treeOid: string,
  path: string,
): { oid: string; data: Buffer } | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) {
      if (entry.mode === '40000') return null;
      const blob = objects.get(entry.oid);
      if (blob === undefined || blob.type !== 'blob') return null;
      return { oid: entry.oid, data: blob.data };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** The tree oid of `path`'s parent directory inside `treeOid` (or the tree itself for a top file). */
function treeDiff(
  objects: Map<string, GitObject>,
  oldTree: string | null,
  newTree: string | null,
  prefix: string,
  out: Array<{ path: string; oldOid: string | null; newOid: string | null }>,
): void {
  const oldEntries = oldTree === null ? [] : parseTree(objects.get(oldTree)?.data ?? Buffer.alloc(0));
  const newEntries = newTree === null ? [] : parseTree(objects.get(newTree)?.data ?? Buffer.alloc(0));
  const oldByName = new Map(oldEntries.map((entry) => [entry.name, entry]));
  const newByName = new Map(newEntries.map((entry) => [entry.name, entry]));
  const names = new Set([...oldByName.keys(), ...newByName.keys()]);
  for (const name of names) {
    const oldEntry = oldByName.get(name);
    const newEntry = newByName.get(name);
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const oldIsDir = oldEntry?.mode === '40000';
    const newIsDir = newEntry?.mode === '40000';
    if (oldIsDir && newIsDir) {
      if (oldEntry.oid !== newEntry.oid) treeDiff(objects, oldEntry.oid, newEntry.oid, path, out);
    } else if (oldIsDir || newIsDir) {
      // A directory added, removed, or replaced by a file: expand the directory side so the
      // change lists the files under it, not the directory name itself.
      if (oldIsDir) treeDiff(objects, oldEntry.oid, null, path, out);
      if (newIsDir) treeDiff(objects, null, newEntry.oid, path, out);
      if (oldIsDir && newEntry !== undefined) out.push({ path, oldOid: null, newOid: newEntry.oid });
      if (newIsDir && oldEntry !== undefined) out.push({ path, oldOid: oldEntry.oid, newOid: null });
    } else if (oldEntry?.oid !== newEntry?.oid) {
      out.push({ path, oldOid: oldEntry?.oid ?? null, newOid: newEntry?.oid ?? null });
    }
  }
}

/** Changed paths between two trees: added, deleted or modified (dirs recursed, not listed). */
export function diffTrees(
  objects: Map<string, GitObject>,
  oldTree: string | null,
  newTree: string | null,
): Array<{ path: string; oldOid: string | null; newOid: string | null }> {
  const out: Array<{ path: string; oldOid: string | null; newOid: string | null }> = [];
  treeDiff(objects, oldTree, newTree, '', out);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** Rebuild a tree from a flat file map (path -> blob oid), creating intermediate trees. */
function rebuildTreeFromFiles(objects: Map<string, GitObject>, files: Map<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, oid] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(objects, 'tree', buildTree(entries));
  };
  return build(root);
}

/**
 * Apply file changes to a base tree: `changes` maps a path to new bytes (create/update) or null
 * (delete). Returns the new tree oid, creating blob and tree objects as needed.
 */
export function applyChangesToTree(
  objects: Map<string, GitObject>,
  baseTreeOid: string | null,
  changes: Map<string, Buffer | null>,
): string {
  const files = new Map<string, string>();
  if (baseTreeOid !== null) {
    for (const file of listTreeFiles(objects, baseTreeOid)) files.set(file.path, file.oid);
  }
  for (const [path, content] of changes) {
    if (content === null) files.delete(path);
    else files.set(path, putObject(objects, 'blob', content));
  }
  return rebuildTreeFromFiles(objects, files);
}

// --------------------------------------------------------------------------- line diff

/** A small line diff: common prefix/suffix trimmed, the rest counted as additions/deletions. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  return { additions: newEnd - start, deletions: oldEnd - start };
}

// --------------------------------------------------------------------------- the store

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  seq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  seq: number;
  comments: Comment[];
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  nextNumber: number;
}

/** An opaque Relay-style global id: base64 of `Kind:part:part`. */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

/** Decode a global id made by globalId(), or null. */
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const segments = text.split(':');
    const kind = segments[0];
    if (kind === undefined || kind === '' || segments.length < 2) return null;
    return { kind, parts: segments.slice(1) };
  } catch {
    return null;
  }
}

export class Store {
  readonly repos = new Map<string, Repo>();
  readonly repoList: Repo[] = [];
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, options: { private?: boolean; description?: string } = {}): Repo | null {
    if (this.repos.has(this.repoKey(VIEWER_LOGIN, name))) return null;
    const { iso } = nextTimestamp();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER_LOGIN,
      fullName: `${VIEWER_LOGIN}/${name}`,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: iso,
      seq: nextOrder(),
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    this.repoList.push(repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = this.repoKey(owner, name);
    const repo = this.repos.get(key);
    if (repo === undefined) return false;
    this.repos.delete(key);
    const index = this.repoList.indexOf(repo);
    if (index >= 0) this.repoList.splice(index, 1);
    return true;
  }

  /** The tip commit of a branch, or null when the branch (or repo) has no commit yet. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Create a branch ref at a commit that must already exist in the store. */
  createBranch(repo: Repo, branch: string, sha: string): boolean {
    if (!repo.objects.has(sha)) return false;
    repo.refs.set(`refs/heads/${branch}`, sha);
    return true;
  }

  /**
   * Commit file changes on a branch (creating the branch from the default tip when it does not
   * exist yet, and the default branch from nothing on an unborn repository). Returns the commit.
   */
  commitFiles(
    repo: Repo,
    branch: string,
    changes: Map<string, Buffer | null>,
    message: string,
  ): { commitOid: string; treeOid: string } {
    const tip = this.branchTip(repo, branch);
    let baseTree: string | null = null;
    const parents: string[] = [];
    if (tip !== null) {
      parents.push(tip);
      baseTree = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
    } else if (branch !== repo.defaultBranch) {
      // A new branch starts at the default branch's tip (the contents API's branch creation).
      const defaultTip = this.branchTip(repo, repo.defaultBranch);
      if (defaultTip !== null) {
        parents.push(defaultTip);
        baseTree = parseCommit(repo.objects.get(defaultTip)?.data ?? Buffer.alloc(0)).tree;
      }
    }
    const treeOid = applyChangesToTree(repo.objects, baseTree, changes);
    const { epochSec } = nextTimestamp();
    const commitOid = putObject(
      repo.objects,
      'commit',
      buildCommit({ tree: treeOid, parents, message: message.endsWith('\n') ? message : `${message}\n`, timestamp: epochSec }),
    );
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return { commitOid, treeOid };
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const { iso } = nextTimestamp();
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdAt: iso,
      updatedAt: iso,
      seq: nextOrder(),
      comments: [],
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    const { iso } = nextTimestamp();
    const comment: Comment = { id: this.nextCommentId, body, createdAt: iso, seq: nextOrder() };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | null {
    const headSha = this.branchTip(repo, head);
    const baseSha = this.branchTip(repo, base);
    if (headSha === null || baseSha === null) return null;
    const { iso } = nextTimestamp();
    const pull: PullRequest = {
      id: this.nextIssueId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      createdAt: iso,
      updatedAt: iso,
      seq: nextOrder(),
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The changed files of a pull request (merge-base tree vs head tree), with line counts. */
  pullRequestFiles(repo: Repo, pull: PullRequest): Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
  }> {
    const base = findMergeBase(repo.objects, pull.headSha, pull.baseSha) ?? pull.baseSha;
    const baseTree = parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
    const headTree = parseCommit(repo.objects.get(pull.headSha)?.data ?? Buffer.alloc(0)).tree;
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const change of diffTrees(repo.objects, baseTree, headTree)) {
      const oldText = change.oldOid === null ? '' : (repo.objects.get(change.oldOid)?.data.toString('utf8') ?? '');
      const newText = change.newOid === null ? '' : (repo.objects.get(change.newOid)?.data.toString('utf8') ?? '');
      const counts = lineDiff(oldText, newText);
      const status = change.oldOid === null ? 'added' : change.newOid === null ? 'removed' : 'modified';
      out.push({
        filename: change.path,
        status,
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
    return out;
  }

  /**
   * Squash-merge a pull request onto its base branch: a three-way merge of the head's changes
   * against the merge-base, applied to the base tip. Returns the merge commit, or a conflict.
   */
  mergePull(repo: Repo, pull: PullRequest): { ok: true; sha: string } | { ok: false; reason: string } {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return { ok: false, reason: 'missing branch tip' };
    const mergeBase = findMergeBase(repo.objects, headTip, baseTip);
    if (mergeBase === null) return { ok: false, reason: 'no merge base' };
    const baseTree = parseCommit(repo.objects.get(mergeBase)?.data ?? Buffer.alloc(0)).tree;
    const headTree = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
    const currentTree = parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
    const changes = new Map<string, Buffer | null>();
    for (const change of diffTrees(repo.objects, baseTree, headTree)) {
      const baseVersion = getFileAtTree(repo.objects, baseTree, change.path);
      const currentVersion = getFileAtTree(repo.objects, currentTree, change.path);
      const headVersion = getFileAtTree(repo.objects, headTree, change.path);
      const baseOid = baseVersion?.oid ?? null;
      const currentOid = currentVersion?.oid ?? null;
      const headOid = headVersion?.oid ?? null;
      // Both sides changed the same path differently since the merge-base: a conflict.
      if (currentOid !== baseOid && headOid !== currentOid && headOid !== baseOid) {
        return { ok: false, reason: 'merge conflict' };
      }
      if (headVersion === null) changes.set(change.path, null);
      else changes.set(change.path, headVersion.data);
    }
    const newTree = applyChangesToTree(repo.objects, currentTree, changes);
    const { epochSec, iso } = nextTimestamp();
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
    const sha = putObject(
      repo.objects,
      'commit',
      buildCommit({ tree: newTree, parents: [baseTip], message, timestamp: epochSec }),
    );
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = iso;
    pull.mergeCommitSha = sha;
    pull.updatedAt = iso;
    return { ok: true, sha };
  }

  /** Commits reachable from a tip, newest first (depth-first, parents in order, deduplicated). */
  commitList(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let index = parents.length - 1; index >= 0; index -= 1) stack.push(parents[index] as string);
    }
    return out;
  }

  /** Find a repo, issue or pull request by its global id. */
  resolveGlobalId(id: string): { repo: Repo; issue?: Issue; pull?: PullRequest } | null {
    const decoded = decodeGlobalId(id);
    if (decoded === null) return null;
    if (decoded.kind === 'Repository' && decoded.parts.length === 1) {
      const repo = this.repoList.find((candidate) => candidate.id === Number(decoded.parts[0]));
      return repo === undefined ? null : { repo };
    }
    if (decoded.kind === 'Issue' && decoded.parts.length === 2) {
      const repo = this.repoList.find((candidate) => candidate.id === Number(decoded.parts[0]));
      const issue = repo?.issues.get(Number(decoded.parts[1]));
      return repo !== undefined && issue !== undefined ? { repo, issue } : null;
    }
    if (decoded.kind === 'PullRequest' && decoded.parts.length === 2) {
      const repo = this.repoList.find((candidate) => candidate.id === Number(decoded.parts[0]));
      const pull = repo?.pulls.get(Number(decoded.parts[1]));
      return repo !== undefined && pull !== undefined ? { repo, pull } : null;
    }
    return null;
  }
}

// --------------------------------------------------------------------------- JSON views (shared by every surface)

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.fullName}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    fork: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.id, issue.number, comment.id),
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://example.invalid/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}
