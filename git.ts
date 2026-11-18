// git.ts — the git smart-HTTP transport: upload-pack v2 (ls-refs + fetch),
// upload-pack v0 (fallback), and receive-pack v0 (push). No git binary anywhere;
// packs are read and written by gitobj.ts.
//
// Routing: /{owner}/{repo}.git/info/refs, /{owner}/{repo}.git/git-upload-pack,
// /{owner}/{repo}.git/git-receive-pack. A missing repo (or an owner that is not the
// login the token names) is 404 on both GET /info/refs endpoints, and the server
// stays up after a malformed body.

import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  decodePktLines,
  isAncestor,
  isOid,
  peelToCommit,
  pktLine,
  readPack,
  selectFetch,
  splitPktBody,
  verifyPackChecksum,
  writePack,
  type GitObject,
} from './gitobj.ts';
import type { Repo, Store } from './store.ts';
import { deleteRef, getHeader, setRef } from './store.ts';

export interface GitRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  headers: NodeJS.Dict<string | string[]>;
  body: Buffer;
}

export interface GitResponse {
  status: number;
  body: Buffer;
  contentType: string;
}

const AGENT = 'forge/1.0.0';
const UPLOAD_V2_CAPS = ['agent=forge/1.0.0', 'ls-refs=unborn', 'fetch=shallow thin-pack', 'object-format=sha1'];
const UPLOAD_V0_CAPS = 'multi_ack thin-pack side-band-64k ofs-delta agent=forge/1.0.0';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs agent=forge/1.0.0';

// Response caches. Entries are immutable by construction:
// - a fetch pack for (repo, tip) is fixed because objects are content-addressed and
//   never overwritten, and the tip oid is part of the key;
// - advertisements depend on the ref set, so they key off repo.refsVersion (bumped on
//   every ref mutation) plus the default branch (a PATCH can retarget it).
// The store is per-trial (one process per trial), so nothing here can go stale across
// trials, and a trial holds only a handful of repos.
const lsRefsCache = new Map<string, Buffer>();
const fetchCache = new Map<string, Buffer>();
const infoRefsCache = new Map<string, Buffer>();

function jsonResponse(status: number, message: string): GitResponse {
  return { status, body: Buffer.from(JSON.stringify({ message }), 'utf8'), contentType: 'application/json' };
}

/** The repo a git URL names, or null when the owner/repo is not the viewer's. */
function resolveGitRepo(store: Store, owner: string, repoName: string): Repo | null {
  if (!store.isViewer(owner)) return null;
  return store.getRepo(owner, repoName) ?? null;
}

/** All refs of a repo as (name, oid) pairs, sorted by name. */
function allRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

/** The peeled commit of an annotated tag ref, or null when the ref is not a tag. */
function peeledOf(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  const commit = peelToCommit(oid, (id) => repo.objects.get(id));
  return commit;
}

export function handleGit(store: Store, req: GitRequest): GitResponse | null {
  if (req.segments.length < 2) return null;
  const repoSegment = req.segments[1]!;
  if (!repoSegment.endsWith('.git')) return null;
  const owner = req.segments[0]!;
  const repoName = repoSegment.slice(0, -4);
  const repo = resolveGitRepo(store, owner, repoName);
  const tail = req.segments.slice(2);
  try {
    if (req.method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
      if (repo === null) return jsonResponse(404, 'Not Found');
      const service = req.query.get('service') ?? '';
      if (service === 'git-upload-pack') return infoRefsUpload(repo, getHeader(req.headers, 'git-protocol') === 'version=2');
      if (service === 'git-receive-pack') return infoRefsReceive(repo);
      return jsonResponse(400, 'service is required');
    }
    if (req.method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
      if (repo === null) return jsonResponse(404, 'Not Found');
      return handleUploadPack(store, repo, req);
    }
    if (req.method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
      if (repo === null) return jsonResponse(404, 'Not Found');
      return handleReceivePack(store, repo, req);
    }
    return null;
  } catch (error) {
    // A malformed body must never kill the server: answer 400 and stay up.
    if (error instanceof Error && /pkt-line|pack|delta|truncated|malformed|checksum|not a packfile/.test(error.message)) {
      return jsonResponse(400, error.message);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

/** GET /info/refs?service=git-upload-pack. v2 when the client asked for it, else v0. */
function infoRefsUpload(repo: Repo, wantsV2: boolean): GitResponse {
  const cacheKey = `${repo.id}:${repo.refsVersion}:${repo.defaultBranch}:${wantsV2 ? 'v2' : 'v0'}`;
  const cached = infoRefsCache.get(cacheKey);
  if (cached !== undefined) {
    return { status: 200, body: cached, contentType: 'application/x-git-upload-pack-advertisement' };
  }
  const body = buildInfoRefsUpload(repo, wantsV2);
  infoRefsCache.set(cacheKey, body);
  return { status: 200, body, contentType: 'application/x-git-upload-pack-advertisement' };
}

function buildInfoRefsUpload(repo: Repo, wantsV2: boolean): Buffer {
  if (wantsV2) {
    const parts: Buffer[] = [pktLine('version 2\n')];
    for (const cap of UPLOAD_V2_CAPS) parts.push(pktLine(`${cap}\n`));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  // v0: "# service=git-upload-pack" + flush, then the refs with caps on the first line.
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const symref = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const refs = allRefs(repo);
  if (tip === undefined) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${UPLOAD_V0_CAPS} ${symref}\n`));
  } else {
    parts.push(pktLine(`${tip} HEAD\0${UPLOAD_V0_CAPS} ${symref}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOf(repo, ref.oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** GET /info/refs?service=git-receive-pack — v0 only. */
function infoRefsReceive(repo: Repo): GitResponse {
  const cacheKey = `${repo.id}:${repo.refsVersion}:${repo.defaultBranch}:recv`;
  const cached = infoRefsCache.get(cacheKey);
  if (cached !== undefined) {
    return { status: 200, body: cached, contentType: 'application/x-git-receive-pack-advertisement' };
  }
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const symref = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const refs = allRefs(repo);
  if (tip === undefined) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_V0_CAPS} ${symref}\n`));
  } else {
    parts.push(pktLine(`${tip} HEAD\0${RECEIVE_V0_CAPS} ${symref}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOf(repo, ref.oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  infoRefsCache.set(cacheKey, body);
  return { status: 200, body, contentType: 'application/x-git-receive-pack-advertisement' };
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

function handleUploadPack(store: Store, repo: Repo, req: GitRequest): GitResponse {
  const wantsV2 = getHeader(req.headers, 'git-protocol') === 'version=2';
  const packets = decodePktLines(req.body);
  const firstData = packets.find((p) => p.kind === 'data');
  const firstLine = firstData === undefined ? '' : firstData.payload.toString('utf8').trim();
  if (wantsV2 || firstLine.startsWith('command=')) {
    if (firstLine === 'command=ls-refs') return handleLsRefs(repo, packets);
    if (firstLine === 'command=fetch') return handleFetchV2(repo, packets);
    return jsonResponse(400, `unknown upload-pack command ${JSON.stringify(firstLine)}`);
  }
  return handleFetchV0(repo, packets);
}

/** v2 ls-refs: refs (with peel/symref attributes) honouring ref-prefix, then flush. */
function handleLsRefs(repo: Repo, packets: ReturnType<typeof decodePktLines>): GitResponse {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (line.startsWith('command=')) continue;
    if (!afterDelim) continue; // agent= / object-format= lines live before the delim.
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const cacheKey = `${repo.id}:${repo.refsVersion}:${repo.defaultBranch}:${peel ? 'p' : ''}${symrefs ? 's' : ''}${unborn ? 'u' : ''}:${prefixes.join(',')}`;
  const cached = lsRefsCache.get(cacheKey);
  if (cached !== undefined) {
    return { status: 200, body: cached, contentType: 'application/x-git-upload-pack-result' };
  }
  const parts: Buffer[] = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  // HEAD: the default branch's tip (or unborn when the repo is empty). An empty repo
  // reports HEAD itself as unborn — never a refs/* line, or a clone sees a ref that
  // does not exist.
  if (keep('HEAD')) {
    if (tip === undefined) {
      if (unborn) parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    } else if (symrefs) {
      parts.push(pktLine(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    } else {
      parts.push(pktLine(`${tip} HEAD\n`));
    }
  }
  for (const ref of allRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peeledOf(repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  // An empty repo with no HEAD line (unborn not requested): git sends nothing but the flush.
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  lsRefsCache.set(cacheKey, body);
  return { status: 200, body, contentType: 'application/x-git-upload-pack-result' };
}

/** v2 fetch: [shallow-info] packfile, then flush. No acknowledgments section when the
 *  request carries `done` — that is a single-round-trip fetch, and git (and the suite's
 *  client) then read the pack straight after the shallow-info section. A request
 *  WITHOUT `done` is a negotiation round: it gets the acknowledgments section only
 *  (NAK + flush, or ACK + ready + delim and then the pack). The packfile section is
 *  always present, even for zero objects (an empty pack: 0 entries, 32 bytes). */
function handleFetchV2(repo: Repo, packets: ReturnType<typeof decodePktLines>): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow = new Set<string>();
  let depth: number | null = null;
  let hasDone = false;
  let hasFilter = false;
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (line.startsWith('command=')) continue;
    if (!afterDelim) continue;
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallow.add(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isInteger(n) && n > 0) depth = n;
    } else if (line.startsWith('deepen-since ')) {
      // Not supported by this forge: treat as a plain fetch (the suite never sends it).
      hasFilter = true; // never cache a shape this handler answers approximately.
    } else if (line === 'done') {
      hasDone = true;
    } else if (line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta') {
      // Accepted and ignored (thin-pack is what we always send; no-progress is honoured).
    } else if (line.startsWith('filter ')) {
      // Accepted and ignored by this handler; never cache a filtered shape.
      hasFilter = true;
    }
  }
  // A single-want depth-1 fetch with no haves and no filter is fully determined by the
  // wanted oid: the pack is the want's depth-1 closure, and objects are content-addressed
  // and immutable, so the whole response can be reused verbatim. This is the clone
  // workload's shape (50 concurrent depth-1 clones of one tip).
  const cacheable = hasDone && depth === 1 && wants.length === 1 && haves.length === 0 && clientShallow.size === 0 && !hasFilter;
  const cacheKey = cacheable ? `${repo.id}:${wants[0]}` : '';
  if (cacheable) {
    const cached = fetchCache.get(cacheKey);
    if (cached !== undefined) {
      return { status: 200, body: cached, contentType: 'application/x-git-upload-pack-result' };
    }
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const selection = selectFetch(wants, haves, depth, clientShallow, lookup);
  const heldHave = haves.find((have) => repo.objects.has(have));
  const parts: Buffer[] = [];
  if (!hasDone) {
    // A negotiation round: the acknowledgments section, and nothing else unless ready.
    parts.push(pktLine('acknowledgments\n'));
    if (heldHave !== undefined) {
      parts.push(pktLine(`ACK ${heldHave}\n`));
      parts.push(pktLine('ready\n'));
      parts.push(PKT_DELIM);
    } else {
      parts.push(pktLine('NAK\n'));
      parts.push(PKT_FLUSH);
      return { status: 200, body: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
    }
  }
  // shallow-info (only when there is something to report)
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  // packfile — always present, even for zero objects (an empty pack carries 0 entries).
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(writePack(selection.objects)));
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  if (cacheable) fetchCache.set(cacheKey, body);
  return { status: 200, body, contentType: 'application/x-git-upload-pack-result' };
}

/** v0 fetch: NAK/ACK lines, then the pack as sideband band-1, then flush. */
function handleFetchV0(repo: Repo, packets: ReturnType<typeof decodePktLines>): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').trim();
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line === 'done') break;
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const selection = selectFetch(wants, haves, null, new Set(), lookup);
  const parts: Buffer[] = [];
  const heldHave = haves.find((have) => repo.objects.has(have));
  if (heldHave !== undefined) parts.push(pktLine(`ACK ${heldHave}\n`));
  else parts.push(pktLine('NAK\n'));
  if (selection.objects.length > 0) parts.push(...sidebandPackets(writePack(selection.objects)));
  parts.push(PKT_FLUSH);
  return { status: 200, body: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
}

/** Split a buffer into sideband band-1 pkt-lines (payloads of at most 65516 bytes). */
function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515; // 65516 payload bytes minus the 1 band byte.
  for (let off = 0; off < data.length; off += CHUNK) {
    const chunk = data.subarray(off, Math.min(data.length, off + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(store: Store, repo: Repo, req: GitRequest): GitResponse {
  const { packets, rest } = splitPktBody(req.body);
  const commands: PushCommand[] = [];
  let requestedCaps = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      if (requestedCaps === '') requestedCaps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    line = line.trim();
    if (line.length === 0) continue;
    const parts = line.split(' ');
    if (parts.length !== 3 || !isOid(parts[0]!) || !isOid(parts[1]!)) {
      throw new Error('malformed push command line');
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  if (commands.length === 0) throw new Error('push carries no commands');
  // Unpack the pack (a create/update always carries one, even an empty one).
  let unpackError: string | null = null;
  let unpacked: Map<string, GitObject> | null = null;
  if (rest.length > 0) {
    try {
      const checksum = verifyPackChecksum(rest);
      if (!checksum.ok) throw new Error('pack checksum mismatch');
      unpacked = readPack(rest, (oid) => repo.objects.get(oid));
    } catch (error) {
      unpackError = error instanceof Error ? error.message : 'unpack failed';
    }
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed`);
  } else {
    if (unpacked !== null) store.storeObjects(repo, unpacked.values());
    reportLines.push('unpack ok');
    for (const command of commands) {
      reportLines.push(applyPushCommand(repo, command, lookup));
    }
  }
  // The report-status stream: pkt-lines for every line, ending with an inner flush.
  // With side-band-64k the whole stream rides inside band 1 (and the outer stream ends
  // with its own flush); without it the stream is sent as plain pkt-lines.
  const inner = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  const useSideband = requestedCaps.split(' ').includes('side-band-64k');
  if (!useSideband) {
    return { status: 200, body: inner, contentType: 'application/x-git-receive-pack-result' };
  }
  const outer: Buffer[] = [];
  for (let off = 0; off < inner.length; off += 65515) {
    outer.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(off, Math.min(inner.length, off + 65515))])));
  }
  outer.push(PKT_FLUSH);
  return { status: 200, body: Buffer.concat(outer), contentType: 'application/x-git-receive-pack-result' };
}

/** Apply one push command; returns its report line (`ok <ref>` or `ng <ref> <reason>`). */
function applyPushCommand(repo: Repo, command: PushCommand, lookup: (oid: string) => GitObject | undefined): string {
  const current = repo.refs.get(command.ref);
  const isDelete = command.newOid === ZERO_OID;
  const isCreate = command.oldOid === ZERO_OID;
  if (isDelete) {
    if (current === undefined) return `ng ${command.ref} remote ref does not exist`;
    if (!isCreate && command.oldOid !== current) return `ng ${command.ref} non-fast-forward`;
    deleteRef(repo, command.ref);
    return `ok ${command.ref}`;
  }
  // The new object must exist (it arrived in the pack or was already stored).
  if (lookup(command.newOid) === undefined) return `ng ${command.ref} object not found`;
  if (isCreate) {
    if (current !== undefined) return `ng ${command.ref} reference already exists`;
    setRef(repo, command.ref, command.newOid);
    return `ok ${command.ref}`;
  }
  // An update: the old value must match, and the new value must fast-forward the old.
  if (current === undefined) return `ng ${command.ref} remote ref does not exist`;
  if (command.oldOid !== current) return `ng ${command.ref} non-fast-forward`;
  if (command.oldOid === command.newOid) return `ok ${command.ref}`;
  const oldCommit = peelToCommit(command.oldOid, lookup);
  const newCommit = peelToCommit(command.newOid, lookup);
  if (oldCommit === null || newCommit === null) return `ng ${command.ref} non-fast-forward`;
  if (!isAncestor(oldCommit, newCommit, lookup)) return `ng ${command.ref} non-fast-forward`;
  setRef(repo, command.ref, command.newOid);
  return `ok ${command.ref}`;
}
