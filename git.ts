// git.ts — git smart HTTP: protocol v2 upload-pack, v0 upload-pack and v0 receive-pack.
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack   (v2 when Git-Protocol: version=2)
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack  (v0 only)
//   POST /{owner}/{repo}.git/git-upload-pack                     (v2 ls-refs / fetch, or v0 fetch)
//   POST /{owner}/{repo}.git/git-receive-pack                    (v0 push, report-status + side-band-64k)
//
// Object ids are SHA-1 throughout; packs are built and read by gitpack.ts. Every update must
// fast-forward: a non-fast-forward push is refused per ref with `ng <ref> non-fast-forward` and
// the ref does not move, while the other refs in the same command list still apply.

import {
  collectReachable,
  findMergeBase,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  peelObject,
  type GitObject,
  type Repo,
  type Store,
  VIEWER_LOGIN,
} from './store.ts';
import {
  decodePktLines,
  packetLines,
  pktLine,
  pktLines,
  readPack,
  writePack,
  ZERO_OID,
} from './gitpack.ts';

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const AGENT = 'forge/1.0';

function notFound(): GitHttpResult {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
}

function badRequest(message: string): GitHttpResult {
  return {
    status: 400,
    contentType: 'application/json; charset=utf-8',
    body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8'),
  };
}

/** All refs of a repo, sorted: HEAD first, then refs/heads/*, then refs/tags/*. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

function defaultTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/** v2 capability advertisement: `version 2` plus one capability line each, then a flush. */
function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

/** v0 ref advertisement: the `# service=...` preamble, the refs, peeled tags, then a flush. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), Buffer.from('0000', 'ascii')];
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
      : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const refs = sortedRefs(repo);
  const tip = defaultTip(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (tip !== null) {
      parts.push(pktLine(`${tip} HEAD${first ? `\0${caps}` : ''}\n`));
      first = false;
    }
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}${first ? `\0${caps}` : ''}\n`));
      first = false;
      const object = repo.objects.get(ref.oid);
      if (ref.name.startsWith('refs/tags/') && object !== undefined && object.type === 'tag') {
        const peeled = peelObject(repo.objects, ref.oid);
        if (peeled !== ref.oid) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function infoRefs(repo: Repo, service: string, gitProtocol: string | undefined): GitHttpResult {
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: UPLOAD_AD, body: v2Advertisement() };
    }
    return { status: 200, contentType: UPLOAD_AD, body: v0Advertisement(repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: RECEIVE_AD, body: v0Advertisement(repo, 'git-receive-pack') };
  }
  return notFound();
}

// --------------------------------------------------------------------------- v2 ls-refs

function lsRefs(repo: Repo, lines: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: string[] = [];
  const tip = defaultTip(repo);
  if (keep('HEAD')) {
    if (tip !== null) {
      out.push(`${tip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    } else if (unborn) {
      out.push(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const object = repo.objects.get(ref.oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelObject(repo.objects, ref.oid);
        if (peeled !== ref.oid) line += ` peeled:${peeled}`;
      }
    }
    out.push(`${line}\n`);
  }
  return pktLines([...out, 'flush']);
}

// --------------------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  /** `deepen-relative`: the deepen count adds to the client's current depth, not absolute. */
  deepenRelative: boolean;
}

/** Parse a v2 fetch request's argument lines (after the delim) into FetchArgs. */
function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenRelative: false };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text === 'deepen-relative') args.deepenRelative = true;
    else if (text.startsWith('deepen ')) {
      const depth = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(depth) && depth > 0) args.depth = depth;
    }
  }
  return args;
}

/**
 * The objects one commit contributes on its own: itself plus its tree's trees and blobs.
 * Parents are never followed: a commit's history is not its own content, and a shallow
 * fetch must not deliver it.
 */
function commitClosure(objects: Map<string, GitObject>, commitOid: string): Set<string> {
  const out = new Set<string>();
  const commit = objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return out;
  out.add(commitOid);
  const queue = [parseCommit(commit.data).tree];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (out.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return out;
}

/**
 * The objects a fetch must send, and the new shallow boundary. `wants` are commit (or tag) ids,
 * `haves` are commits the client already holds, `depth` caps the generations from the wants.
 */
function computeFetch(
  repo: Repo,
  args: FetchArgs,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const wants = [...new Set(args.wants)].filter((oid) => isObjectId(oid) && repo.objects.has(oid));
  // Objects the client already holds. A shallow boundary is held only as itself plus its tree:
  // the client does NOT have its ancestors, so they must still be sendable on a deepen.
  const held = new Set<string>();
  for (const have of args.haves) {
    if (isObjectId(have) && repo.objects.has(have)) {
      if (args.shallow.includes(have)) {
        for (const oid of commitClosure(repo.objects, have)) held.add(oid);
      } else {
        for (const oid of collectReachable(repo.objects, [have])) held.add(oid);
      }
    }
  }
  // Resolve wants to commits (a tag want contributes its tag object, then its target commit).
  const tagObjects = new Map<string, GitObject>();
  const commitWants: string[] = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagObjects.set(want, object);
      commitWants.push(peelObject(repo.objects, want));
    } else if (object.type === 'commit') {
      commitWants.push(want);
    }
  }
  // With `deepen-relative` the deepen count adds to the client's current depth, measured as
  // the distance of its shallow boundaries from the wants, plus one (a boundary at distance 0
  // is a depth-1 clone). Without it, `deepen` is already the absolute new depth.
  let effectiveDepth = args.depth;
  if (args.deepenRelative && args.depth !== null) {
    const distances = new Map<string, number>();
    const breadth: string[] = [];
    for (const want of commitWants) {
      if (!distances.has(want)) {
        distances.set(want, 0);
        breadth.push(want);
      }
    }
    let current = 1;
    while (breadth.length > 0) {
      const oid = breadth.shift() as string;
      const dist = distances.get(oid) as number;
      if (args.shallow.includes(oid)) current = Math.max(current, dist + 1);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!distances.has(parent)) {
          distances.set(parent, dist + 1);
          breadth.push(parent);
        }
      }
    }
    effectiveDepth = args.depth + current;
  }
  // Walk the commit graph from the wants, tracking distance; depth caps the generations.
  const included = new Set<string>();
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const want of commitWants) {
    if (!distance.has(want)) {
      distance.set(want, 0);
      queue.push(want);
    }
  }
  const shallow = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const dist = distance.get(oid) as number;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    if (included.has(oid)) continue;
    included.add(oid);
    const parents = parseCommit(object.data).parents;
    const atBoundary = effectiveDepth !== null && dist >= effectiveDepth - 1;
    if (atBoundary) {
      if (parents.length > 0) shallow.add(oid);
      continue;
    }
    for (const parent of parents) {
      if (!distance.has(parent)) {
        distance.set(parent, dist + 1);
        queue.push(parent);
      }
    }
  }
  // The objects to send: each included commit plus its tree's trees and blobs — never the
  // parents of an included commit (a depth cap makes them a boundary, not a delivery).
  const send = new Set<string>();
  for (const oid of included) {
    for (const entry of commitClosure(repo.objects, oid)) {
      if (!held.has(entry)) send.add(entry);
    }
  }
  for (const oid of tagObjects.keys()) {
    if (!held.has(oid)) send.add(oid);
  }
  // A previous shallow boundary that is now fully included (all its parents are too) unshallows.
  const unshallow: string[] = [];
  for (const boundary of args.shallow) {
    if (!included.has(boundary)) continue;
    const object = repo.objects.get(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => included.has(parent))) unshallow.push(boundary);
  }
  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, shallow: [...shallow].sort(), unshallow };
}

/** Wrap pack bytes into sideband band-1 pkt-lines (chunks fit the pkt-line maximum). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 60000;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const piece = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), piece])));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return parts;
}

function fetchV2(repo: Repo, args: FetchArgs): GitHttpResult {
  const { objects, shallow, unshallow } = computeFetch(repo, args);
  const pack = writePack(objects);
  const havesExist = args.haves.length > 0 && args.haves.every((have) => repo.objects.has(have));
  const parts: Buffer[] = [];
  // Protocol v2 sends the acknowledgments section only when the client sent haves; a client
  // that sent none (a fresh clone) expects the response to open with shallow-info or packfile.
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (!havesExist) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const have of args.haves) parts.push(pktLine(`ACK ${have}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(Buffer.from('0001', 'ascii'));
  }
  if (args.depth !== null || args.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(Buffer.from('0000', 'ascii'));
  return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.concat(parts) };
}

function fetchV0(repo: Repo, args: FetchArgs): GitHttpResult {
  const { objects, shallow, unshallow } = computeFetch(repo, args);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  const havesExist = args.haves.length > 0 && args.haves.every((have) => repo.objects.has(have));
  if (args.haves.length === 0 || !havesExist) parts.push(pktLine('NAK\n'));
  else for (const have of args.haves) parts.push(pktLine(`ACK ${have}\n`));
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(Buffer.from('0000', 'ascii'));
  return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.concat(parts) };
}

function uploadPack(repo: Repo, body: Buffer, gitProtocol: string | undefined): GitHttpResult {
  let decoded;
  try {
    decoded = decodePktLines(body);
  } catch {
    return badRequest('malformed pkt-line stream');
  }
  const lines = packetLines(decoded.packets);
  if (gitProtocol === 'version=2') {
    const command = lines[0]?.replace(/\n$/, '') ?? '';
    const delimIndex = decoded.packets.findIndex((packet) => packet.kind === 'delim');
    const argLines = delimIndex >= 0 ? lines.slice(delimIndex) : lines.slice(1);
    // packetLines drops control packets, so rebuild the argument list from the data lines after
    // the command line: lines[0] is the command; the rest are arguments (agent/object-format
    // lines included, harmlessly ignored by the parsers).
    const args = lines.slice(1);
    if (command === 'command=ls-refs') return { status: 200, contentType: UPLOAD_RESULT, body: lsRefs(repo, args) };
    if (command === 'command=fetch') return fetchV2(repo, parseFetchArgs(args));
    return badRequest(`unknown protocol v2 command ${JSON.stringify(command)}`);
  }
  // v0: wants (with shallow/deepen) until the first flush, then haves and done until the second.
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, deepenRelative: false };
  let section = 0;
  for (const packet of decoded.packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (text.startsWith('want ')) args.wants.push(text.slice(5, 45));
      else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) {
        const depth = Number.parseInt(text.slice(7).trim(), 10);
        if (Number.isFinite(depth) && depth > 0) args.depth = depth;
      }
    } else {
      if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    }
  }
  if (args.wants.length === 0) return badRequest('v0 upload-pack sent no want lines');
  return fetchV0(repo, args);
}

// --------------------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: Repo, body: Buffer): GitHttpResult {
  let decoded;
  try {
    decoded = decodePktLines(body, { allowTrailing: true });
  } catch {
    return badRequest('malformed pkt-line stream');
  }
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    if (nul >= 0) {
      const caps = text.slice(nul + 1);
      if (caps.includes('side-band-64k')) sideband = true;
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match === null) continue;
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  if (commands.length === 0) return badRequest('receive-pack sent no commands');
  // Unpack the pack that follows the command list (when one was sent).
  const packBytes = decoded.rest;
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  // Validate every command against the refs as they stand, then apply the accepted ones.
  const report: string[] = [];
  if (unpackError !== null) {
    report.push(`unpack ${unpackError}\n`);
    for (const command of commands) report.push(`ng ${command.ref} unpack failed\n`);
  } else {
    report.push('unpack ok\n');
    const accepted: PushCommand[] = [];
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let reason: string | null = null;
      if (command.newOid === ZERO_OID) {
        if (current === undefined) reason = 'remote ref does not exist';
        else if (command.oldOid !== ZERO_OID && command.oldOid !== current) reason = 'non-fast-forward';
      } else if (command.oldOid === ZERO_OID) {
        if (current !== undefined) reason = 'non-fast-forward';
        else if (!repo.objects.has(command.newOid)) reason = 'object not found';
      } else {
        if (current === undefined) reason = 'non-fast-forward';
        else if (command.oldOid !== current) reason = 'non-fast-forward';
        else if (command.newOid === current) reason = null;
        else if (!repo.objects.has(command.newOid)) reason = 'object not found';
        else if (!isAncestor(repo.objects, current, command.newOid)) reason = 'non-fast-forward';
      }
      if (reason === null) {
        accepted.push(command);
        report.push(`ok ${command.ref}\n`);
      } else {
        report.push(`ng ${command.ref} ${reason}\n`);
      }
    }
    for (const command of accepted) {
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
    }
  }
  const reportStream = pktLines([...report, 'flush']);
  let responseBody: Buffer;
  if (sideband) {
    const parts: Buffer[] = [];
    const CHUNK = 60000;
    for (let offset = 0; offset < reportStream.length; offset += CHUNK) {
      const piece = reportStream.subarray(offset, Math.min(reportStream.length, offset + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), piece])));
    }
    parts.push(Buffer.from('0000', 'ascii'));
    responseBody = Buffer.concat(parts);
  } else {
    responseBody = reportStream;
  }
  return { status: 200, contentType: RECEIVE_RESULT, body: responseBody };
}

// --------------------------------------------------------------------------- routing

/**
 * Handle a git smart-HTTP request. Returns null when the path is not a git route (the caller
 * answers its JSON 404). `tail` is the path after `/{owner}/{repo}.git`.
 */
export function handleGit(
  store: Store,
  method: string,
  owner: string,
  repoName: string,
  tail: string[],
  query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
): GitHttpResult | null {
  if (owner !== VIEWER_LOGIN) return notFound();
  const repo = store.getRepo(owner, repoName);
  if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && method === 'GET') {
    if (repo === undefined) return notFound();
    const service = query.get('service') ?? '';
    return infoRefs(repo, service, headers['git-protocol']);
  }
  if (tail.length === 1 && tail[0] === 'git-upload-pack' && method === 'POST') {
    if (repo === undefined) return notFound();
    return uploadPack(repo, body, headers['git-protocol']);
  }
  if (tail.length === 1 && tail[0] === 'git-receive-pack' && method === 'POST') {
    if (repo === undefined) return notFound();
    return receivePack(repo, body);
  }
  return null;
}

// Re-exported for the conformance suite's own reference (and to keep the import graph explicit).
export { findMergeBase };
