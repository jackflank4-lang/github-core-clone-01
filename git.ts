// git.ts — the git smart-HTTP surfaces: info/refs advertisements (v0 and v2),
// ls-refs and fetch over protocol v2, v0 fetch, and git-receive-pack.
// Written fresh in this session from the git wire format and the competition
// checks. Stdlib only: node:http.

import type { ServerResponse } from 'node:http';
import { collectReachable, commitTree, type Forge, type Repo } from './store.ts';
import { Ctx, nextRequestId, sendJson, sendNotFound } from './server.ts';
import {
  decodePktLines,
  encodePktLine,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLineDelim,
  pktLineFlush,
  readPack,
  writeEmptyPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitobj.ts';

const UPLOAD_PACK_SERVICE = 'git-upload-pack';
const RECEIVE_PACK_SERVICE = 'git-receive-pack';

const V0_UPLOAD_CAPS = 'symref=HEAD:refs/heads/main side-band-64k ofs-delta shallow';
const V0_RECEIVE_CAPS = 'symref=HEAD:refs/heads/main report-status side-band-64k delete-refs ofs-delta';
const V2_CAPABILITIES = ['fetch=shallow', 'ls-refs', 'object-format=sha1'];

/** All ref names in git's sorted order. */
export function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** The ref lines for an advertisement: `<oid> <ref>` plus peel lines for annotated tags. */
function advertisementRefLines(repo: Repo, includePeel: boolean): string[] {
  const lines: string[] = [];
  for (const refName of sortedRefNames(repo)) {
    const oid = repo.refs.get(refName)!;
    lines.push(`${oid} ${refName}\n`);
    if (includePeel) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'tag') {
        lines.push(`${parseTag(object.data).object} ${refName}^{}\n`);
      }
    }
  }
  return lines;
}

/** The v0 advertisement body for one service. */
function v0Advertisement(repo: Repo, service: string): Buffer {
  const caps = service === RECEIVE_PACK_SERVICE ? V0_RECEIVE_CAPS : V0_UPLOAD_CAPS;
  const parts: Buffer[] = [];
  const serviceLine = `# service=${service}\n`;
  parts.push(encodePktLine(serviceLine), pktLineFlush());
  if (repo.refs.size === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headTip = repo.refs.get('refs/heads/main');
    if (headTip) {
      parts.push(encodePktLine(`${headTip} HEAD\0${caps}\n`));
    } else {
      // A repository with refs but no main branch: advertise the first head.
      const firstHead = sortedRefNames(repo).find((name) => name.startsWith('refs/heads/'));
      if (firstHead) parts.push(encodePktLine(`${repo.refs.get(firstHead)} HEAD\0${caps}\n`));
    }
    for (const line of advertisementRefLines(repo, true)) parts.push(encodePktLine(line));
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/** The protocol-v2 capability advertisement (upload-pack only). */
function v2Advertisement(): Buffer {
  const parts: Buffer[] = [encodePktLine('version 2\n')];
  for (const capability of V2_CAPABILITIES) parts.push(encodePktLine(`${capability}\n`));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/** Split a sideband pack into band-1 pkt-lines (pack data chunked to 65515 bytes). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    packets.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) {
    // A zero-length pack still needs one band-1 packet so the section carries packets.
    packets.push(encodePktLine(Buffer.from([1])));
  }
  return packets;
}

/**
 * The set of objects the server must send for a fetch, and the shallow / unshallow
 * lines for the response. `depth` limits the commit closure (distance < depth);
 * `haves` are the objects the client already holds; `clientShallow` are the
 * commits the client currently treats as shallow.
 *
 * A commit is shallow only when a parent was cut by the depth / deepen-since
 * limit — a parent the client already holds does not make it shallow (a normal
 * incremental fetch carries no shallow lines at all). A client's shallow commit
 * is unshallow when it and all of its parents are now within the traversal.
 */
export function computeSendSet(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
  deepenSince: number | null,
): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const clientShallowSet = new Set(clientShallow);

  // The objects the client already holds: the closure of the haves, stopping at
  // the client's shallow boundary (a shallow commit's own tree is held, its
  // parents are not).
  const held = new Set<string>();
  {
    const queue: string[] = [];
    for (const have of haves) {
      if (have && have !== ZERO_OID && !held.has(have)) {
        held.add(have);
        queue.push(have);
      }
    }
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (clientShallowSet.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      if (object.type === 'commit') {
        const view = parseCommit(object.data);
        if (view.tree && !held.has(view.tree)) {
          held.add(view.tree);
          queue.push(view.tree);
        }
        for (const parent of view.parents) {
          if (!held.has(parent)) {
            held.add(parent);
            queue.push(parent);
          }
        }
      } else if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        if (target && !held.has(target)) {
          held.add(target);
          queue.push(target);
        }
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (!held.has(entry.oid)) {
            held.add(entry.oid);
            queue.push(entry.oid);
          }
        }
      }
    }
  }

  const committerTimestamp = (commitOid: string): number | null => {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    const match = / (\d+) \+0000$/.exec(parseCommit(object.data).committer);
    if (!match) return null;
    const value = Number.parseInt(match[1]!, 10);
    return Number.isFinite(value) ? value : null;
  };

  // The commits the traversal reaches within the limits, the commits to send
  // (those minus what the client holds), and the send-set commits whose parent
  // was cut by the depth / deepen-since limit.
  const sendCommits = new Set<string>();
  const included = new Set<string>();
  const cutByLimit = new Set<string>();
  {
    interface Work {
      oid: string;
      distance: number;
    }
    const queue: Work[] = [];
    for (const want of wants) {
      if (want && want !== ZERO_OID) queue.push({ oid: want, distance: 0 });
    }
    const seen = new Set<string>();
    while (queue.length > 0) {
      const { oid, distance } = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        // A wanted tag is itself part of the send set (its object must
        // round-trip, e.g. clone-annotated-tag); its target is traversed at
        // the same distance (a tag adds no depth).
        included.add(oid);
        if (!held.has(oid)) sendCommits.add(oid);
        const target = parseTag(object.data).object;
        if (target && !seen.has(target)) queue.push({ oid: target, distance });
        continue;
      }
      if (object.type !== 'commit') continue;
      included.add(oid);
      if (!held.has(oid)) sendCommits.add(oid);
      const view = parseCommit(object.data);
      for (const parent of view.parents) {
        let parentBeyondLimit = false;
        if (depth !== null && distance + 1 >= depth) parentBeyondLimit = true;
        if (!parentBeyondLimit && deepenSince !== null) {
          const parentTs = committerTimestamp(parent);
          if (parentTs !== null && parentTs < deepenSince) parentBeyondLimit = true;
        }
        if (parentBeyondLimit) {
          if (!held.has(oid)) cutByLimit.add(oid);
        } else if (!seen.has(parent)) {
          queue.push({ oid: parent, distance: distance + 1 });
        }
      }
    }
  }

  const shallow: string[] = [...cutByLimit].filter((oid) => sendCommits.has(oid)).sort();

  // A client's shallow commit is unshallow when it and all of its parents are
  // now within the traversal.
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (!included.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => included.has(parent))) unshallow.push(oid);
  }
  unshallow.sort();

  // The objects to send: the tree/blob closure of the send-set commits,
  // minus what the client already holds. This must NOT follow parent links
  // (collectReachable does) — the depth limit already decided the commit
  // set, and following parents would send the full history for a shallow
  // fetch and tank clone perf.
  const objects = new Map<string, GitObject>();
  const reachable = collectSendObjects(repo, [...sendCommits]);
  for (const oid of reachable) {
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) objects.set(oid, object);
  }
  return { objects, shallow, unshallow };
}

/** The tree/blob closure of a set of commits/tags, without following parent links. */
function collectSendObjects(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) {
    if (root && root !== ZERO_OID && !seen.has(root)) {
      seen.add(root);
      queue.push(root);
    }
  }
  while (queue.length > 0) {
    const oid = queue.pop()!;
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      if (view.tree && !seen.has(view.tree)) {
        seen.add(view.tree);
        queue.push(view.tree);
      }
      // Do NOT follow parents — the depth limit already decided the set.
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (target && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (!seen.has(entry.oid)) {
          seen.add(entry.oid);
          queue.push(entry.oid);
        }
      }
    }
  }
  return seen;
}

/** Whether any have is an ancestor of (or equal to) any want — the ACK target. */
function findCommon(repo: Repo, wants: readonly string[], haves: readonly string[]): string | null {
  for (const have of haves) {
    if (!have || have === ZERO_OID) continue;
    for (const want of wants) {
      if (!want || want === ZERO_OID) continue;
      const wantObject = repo.objects.get(want);
      if (!wantObject) continue;
      const tip = wantObject.type === 'tag' ? parseTag(wantObject.data).object : want;
      // Walk the want's ancestors for the have.
      const seen = new Set<string>();
      const stack: string[] = [tip];
      while (stack.length > 0) {
        const oid = stack.pop()!;
        if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
        seen.add(oid);
        if (oid === have) return have;
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) stack.push(parent);
      }
    }
  }
  return null;
}

function ackLines(repo: Repo, wants: readonly string[], haves: readonly string[]): Buffer[] {
  const common = haves.length > 0 ? findCommon(repo, wants, haves) : null;
  if (common) return [encodePktLine(`ACK ${common}\n`), encodePktLine('ready\n')];
  return [encodePktLine('NAK\n')];
}

/** Parse a fetch request body (v0 or v2) into its fields, tolerating either layout. */
export function parseFetchRequest(body: Buffer): {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  command: string | null;
} {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  const deepenNot: string[] = [];
  let depth: number | null = null;
  let deepenSince: number | null = null;
  let command: string | null = null;
  // Each pkt-line is one logical line, but most v2 argument packets carry NO
  // trailing newline — concatenating the payloads glues the first `want`
  // onto the preceding packet ("...ofs-deltawant <oid>") so it is never
  // parsed. Parse each packet's payload as its own line(s) instead.
  const lines: string[] = [];
  try {
    const { packets } = decodePktLines(body);
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      for (const piece of packet.payload.toString('utf8').split('\n')) {
        if (piece !== '') lines.push(piece);
      }
    }
  } catch {
    for (const piece of body.toString('utf8').split('\n')) {
      if (piece !== '') lines.push(piece);
    }
  }
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '') continue;
    if (line.startsWith('command=')) command = line.slice('command='.length);
    else if (line.startsWith('want ')) {
      // v0's first want line carries the capabilities after a NUL
      // ("want <oid>\0side-band-64k ..."); strip at the NUL, then take the
      // first whitespace-separated token as the oid.
      const rest = line.slice(5).split('\0')[0]!.trim().split(/\s+/)[0];
      if (rest && isObjectId(rest)) wants.push(rest);
    } else if (line.startsWith('have ')) {
      const rest = line.slice(5).trim();
      if (isObjectId(rest)) haves.push(rest);
    } else if (line.startsWith('shallow ')) {
      const rest = line.slice(8).trim();
      if (isObjectId(rest)) shallow.push(rest);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    } else if (line.startsWith('deepen-since ')) {
      const n = Number.parseInt(line.slice(13).trim(), 10);
      if (Number.isFinite(n)) deepenSince = n;
    } else if (line.startsWith('deepen-not ')) {
      deepenNot.push(line.slice(11).trim());
    }
  }
  return { wants, haves, shallow, depth, deepenSince, deepenNot, command };
}

/** Parse an ls-refs request body (v2) into its options. */
function parseLsRefsRequest(body: Buffer): { peel: boolean; symrefs: boolean; prefixes: string[] } {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  // Same no-trailing-newline issue as parseFetchRequest: parse each packet's
  // payload as its own line(s), never concatenate raw payloads.
  const lines: string[] = [];
  try {
    const { packets } = decodePktLines(body);
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      for (const piece of packet.payload.toString('utf8').split('\n')) {
        if (piece !== '') lines.push(piece);
      }
    }
  } catch {
    for (const piece of body.toString('utf8').split('\n')) {
      if (piece !== '') lines.push(piece);
    }
  }
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    else if (line.startsWith('ref-prefix=')) prefixes.push(line.slice('ref-prefix='.length));
  }
  return { peel, symrefs, prefixes };
}

/** The ls-refs response lines for a repository. */
function lsRefsLines(repo: Repo, options: { peel: boolean; symrefs: boolean; prefixes: string[] }): string[] {
  const lines: string[] = [];
  const headTip = repo.refs.get('refs/heads/main');
  const include = (name: string): boolean =>
    options.prefixes.length === 0 || options.prefixes.some((prefix) => name.startsWith(prefix));
  if (headTip && include('HEAD')) {
    let line = `${headTip} HEAD`;
    if (options.symrefs) line += ' symref-target:refs/heads/main';
    lines.push(`${line}\n`);
  }
  for (const refName of sortedRefNames(repo)) {
    if (!include(refName)) continue;
    const oid = repo.refs.get(refName)!;
    // v2 ls-refs carries the peel as an attribute on the SAME line
    // ("<oid> <ref> peeled:<commit>"), not as a separate "^{}" line
    // (that form is only for the v0 advertisement).
    let line = `${oid} ${refName}`;
    if (options.peel) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'tag') line += ` peeled:${parseTag(object.data).object}`;
    }
    lines.push(`${line}\n`);
  }
  return lines;
}

function sendGitResult(res: ServerResponse, ctx: Ctx, service: string, body: Buffer): void {
  res.writeHead(200, {
    'Content-Type': `application/x-${service}-result`,
    'X-GitHub-Request-Id': ctx.requestId,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function sendGitAdvertisement(res: ServerResponse, ctx: Ctx, service: string, body: Buffer): void {
  res.writeHead(200, {
    'Content-Type': `application/x-${service}-advertisement`,
    'X-GitHub-Request-Id': ctx.requestId,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function isGitPath(pathParts: string[]): boolean {
  return pathParts.length >= 2 && pathParts[1]!.endsWith('.git');
}

export function handleGit(forge: Forge, ctx: Ctx, res: ServerResponse): boolean {
  if (!isGitPath(ctx.pathParts)) return false;
  try {
    return handleGitInner(forge, ctx, res);
  } catch (err) {
    // A malformed git request must never take the server down.
    if (!res.headersSent) {
      sendJson(res, 400, ctx, { message: (err as Error).message || 'Bad git request' });
    } else {
      res.end();
    }
    return true;
  }
}

function handleGitInner(forge: Forge, ctx: Ctx, res: ServerResponse): boolean {
  const owner = ctx.pathParts[0]!;
  const repoName = ctx.pathParts[1]!.slice(0, -'.git'.length);
  const rest = ctx.pathParts.slice(2);

  if (!ctx.token) {
    sendJson(res, 401, ctx, { message: 'Requires authentication' });
    return true;
  }
  const repo = forge.getRepo(owner, repoName);
  if (!repo) {
    sendNotFound(res, ctx);
    return true;
  }

  // GET /<owner>/<repo>.git/info/refs?service=...
  if (ctx.method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    const service = ctx.query.get('service') ?? '';
    const protocol = ctx.headers['git-protocol'];
    const wantsV2 = service === UPLOAD_PACK_SERVICE && typeof protocol === 'string' && protocol.includes('version=2');
    if (service !== UPLOAD_PACK_SERVICE && service !== RECEIVE_PACK_SERVICE) {
      sendNotFound(res, ctx);
      return true;
    }
    if (wantsV2) {
      sendGitAdvertisement(res, ctx, service, v2Advertisement());
    } else {
      sendGitAdvertisement(res, ctx, service, v0Advertisement(repo, service));
    }
    return true;
  }

  // POST /<owner>/<repo>.git/git-upload-pack
  if (ctx.method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
    const protocol = ctx.headers['git-protocol'];
    const isV2 = typeof protocol === 'string' && protocol.includes('version=2');
    const request = parseFetchRequest(ctx.body);
    if (isV2 && request.command === 'ls-refs') {
      const options = parseLsRefsRequest(ctx.body);
      const parts: Buffer[] = [];
      for (const line of lsRefsLines(repo, options)) parts.push(encodePktLine(line));
      parts.push(pktLineFlush());
      sendGitResult(res, ctx, UPLOAD_PACK_SERVICE, Buffer.concat(parts));
      return true;
    }
    // fetch (v0 and v2 share the send-set logic; only the framing differs).
    // Protocol v2 sections are named — `acknowledgments`, `shallow-info` and
    // `packfile` — each introduced by its own header line, separated by a
    // delim. A section is omitted entirely when it has nothing to say: a
    // clone (no haves, no depth) answers with the packfile section alone,
    // and a fetch with no shallow lines omits shallow-info. v0 sends the
    // bare ack / shallow lines and then the sideband pack.
    const { objects, shallow, unshallow } = computeSendSet(repo, request.wants, request.haves, request.shallow, request.depth, request.deepenSince);
    const pack = writePack(objects.values());
    const parts: Buffer[] = [];
    if (isV2) {
      const hasAcks = request.haves.length > 0;
      const hasShallowInfo = shallow.length > 0 || unshallow.length > 0;
      const ackLinesOut = hasAcks ? ackLines(repo, request.wants, request.haves) : [];
      // 'ready' is present only when a common ancestor was found (ACK + ready);
      // a bare NAK means no ready. The ack section is terminated by a delim
      // ONLY when ready was sent — after a NAK (no ready) the section ends
      // with a flush and no further sections follow in this response (real
      // git rejects "no other sections to be sent after no 'ready'").
      // NOTE: ackLinesOut are pkt-line buffers, so strip the 4-byte header
      // before comparing (the payload is "ready\n", the buffer is "000aready\n").
      const ready = ackLinesOut.some((b) => b.subarray(4).toString('utf8').trim() === 'ready');
      if (hasAcks) {
        parts.push(encodePktLine('acknowledgments\n'));
        for (const line of ackLinesOut) parts.push(line);
        if (!ready) {
          parts.push(pktLineFlush());
          sendGitResult(res, ctx, UPLOAD_PACK_SERVICE, Buffer.concat(parts));
          return true;
        }
        parts.push(pktLineDelim());
      }
      if (hasShallowInfo) {
        parts.push(encodePktLine('shallow-info\n'));
        for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
        for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
        parts.push(pktLineDelim());
      }
      parts.push(encodePktLine('packfile\n'));
      for (const packet of sidebandPackets(pack)) parts.push(packet);
      parts.push(pktLineFlush());
    } else {
      for (const line of ackLines(repo, request.wants, request.haves)) parts.push(line);
      for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
      for (const packet of sidebandPackets(pack)) parts.push(packet);
      parts.push(pktLineFlush());
    }
    sendGitResult(res, ctx, UPLOAD_PACK_SERVICE, Buffer.concat(parts));
    return true;
  }

  // POST /<owner>/<repo>.git/git-receive-pack
  if (ctx.method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
    handleReceivePack(forge, repo, ctx, res);
    return true;
  }

  sendNotFound(res, ctx);
  return true;
}

interface ReceiveCommand {
  oldOid: string;
  newOid: string;
  refName: string;
}

function handleReceivePack(forge: Forge, repo: Repo, ctx: Ctx, res: ServerResponse): void {
  // The body is command pkt-lines, a flush, then the raw pack bytes.
  let commands: ReceiveCommand[] = [];
  let packBytes = Buffer.alloc(0);
  try {
    const { packets, tail } = decodePktLines(ctx.body);
    packBytes = tail;
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      // The first command line carries the capabilities after a NUL; strip
      // everything from the first NUL onward (a regex with `$` fails here
      // when the line ends with a newline, so split instead).
      const line = packet.payload.toString('utf8').split('\0')[0]!.trim();
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
      if (match) commands.push({ oldOid: match[1]!, newOid: match[2]!, refName: match[3]! });
    }
  } catch {
    commands = [];
    packBytes = Buffer.alloc(0);
  }

  // Unpack first: the pack's objects land in the repository even when a ref
  // update is refused.
  let unpackOk = true;
  let unpackError = '';
  if (packBytes.length > 0) {
    try {
      const pack = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of pack.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackError = (err as Error).message;
    }
  } else {
  }

  const reportLines: string[] = [];
  if (unpackOk) {
    reportLines.push('unpack ok\n');
  } else {
    reportLines.push(`unpack ${unpackError || 'failed'}\n`);
  }

  for (const command of commands) {
    const current = repo.refs.get(command.refName);
    let reason: string | null = null;
    if (command.oldOid === ZERO_OID && command.newOid === ZERO_OID) {
      reason = 'invalid old and new values';
    } else if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) reason = 'already exists';
      else if (command.newOid !== ZERO_OID && !repo.objects.has(command.newOid)) reason = 'new object is missing';
    } else if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) reason = 'remote ref does not exist';
      else if (current !== command.oldOid) reason = 'non-fast-forward';
    } else {
      // Update.
      if (current === undefined) reason = 'remote ref does not exist';
      else if (current !== command.oldOid) reason = 'non-fast-forward';
      else if (!repo.objects.has(command.newOid)) reason = 'new object is missing';
      else {
        const newObject = repo.objects.get(command.newOid)!;
        const newTip = newObject.type === 'tag' ? parseTag(newObject.data).object : command.newOid;
        const currentObject = repo.objects.get(current)!;
        const currentTip = currentObject.type === 'tag' ? parseTag(currentObject.data).object : current;
        if (!isAncestorOf(repo, currentTip, newTip)) reason = 'non-fast-forward';
      }
    }
    if (reason === null) {
      if (command.newOid === ZERO_OID) repo.refs.delete(command.refName);
      else repo.refs.set(command.refName, command.newOid);
      repo.restJson = null;
      reportLines.push(`ok ${command.refName}\n`);
    } else {
      reportLines.push(`ng ${command.refName} ${reason}\n`);
    }
  }

  // The report is itself pkt-lined, then wrapped in band-1 sideband packets.
  // Sideband report — the exact framing a real git server sends (verified
  // against git daemon 2.43): the report-status lines are PKT-LINED inside
  // band 1, followed by an INNER flush (0000) inside band 1, then an OUTER
  // flush ending the sideband stream. Without the inner flush git reports a
  // hang-up; with raw (unframed) lines inside band 1 git fails reading
  // "unpa" as a pkt-line length. The suite's client accepts this framing
  // too (its parsePushReport decodes pkt-lined band-1 data).
  const reportBody = Buffer.concat([
    ...reportLines.map((line) => encodePktLine(line)),
    pktLineFlush(),
  ]);
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < reportBody.length; offset += CHUNK) {
    const chunk = reportBody.subarray(offset, Math.min(offset + CHUNK, reportBody.length));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktLineFlush());
  sendGitResult(res, ctx, RECEIVE_PACK_SERVICE, Buffer.concat(parts));
}

/** Whether `ancestor` is reachable from `tip` (tags are dereferenced first). */
function isAncestorOf(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    if (oid === ancestor) return true;
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
      continue;
    }
    if (object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** Re-exported for the REST layer: the blob SHA-1 of decoded content. */
export function blobSha(data: Buffer): string {
  return hashObject('blob', data);
}
