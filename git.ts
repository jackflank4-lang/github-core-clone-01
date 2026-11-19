// git.ts — git smart-HTTP protocol: advertisements, ls-refs, fetch (v2/v0),
// receive-pack (push). Written from scratch for the github-core-clone-01
// forge (Node 22, stdlib only). All reads/writes go through the store.

import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  decodePktLines,
  makeObject,
  pktLine,
  readPack,
  sideband,
  writePack,
  type GitObject,
  type Pkt,
} from './gitpack.ts';
import { Repo, isZeroOid } from './store.ts';

const AGENT = 'forge/1.0';

export interface GitResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResult {
  return { status: 200, contentType, body };
}

function err(status: number, message: string): GitResult {
  return { status, contentType: 'text/plain', body: Buffer.from(message, 'utf8') };
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  const lines = ['version 2', `agent=${AGENT}`, 'ls-refs=unborn', 'fetch=shallow filter', 'object-format=sha1'];
  return Buffer.concat([...lines.map((l) => pktLine(`${l}\n`)), PKT_FLUSH]);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', caps: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`)];
  const head = repo.headOid();
  const refLines: Buffer[] = [];
  if (head !== undefined) {
    refLines.push(pktLine(`${head} HEAD\0${caps}\n`));
  } else {
    refLines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  }
  for (const { name, oid } of repo.sortedRefs()) {
    refLines.push(pktLine(`${oid} ${name}\n`));
    const peeled = repo.peel(oid);
    if (peeled.isTag) refLines.push(pktLine(`${peeled.target} ${name}^{}\n`));
  }
  return Buffer.concat([...parts, ...refLines, PKT_FLUSH]);
}

const UPLOAD_V0_CAPS = `side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=${AGENT} symref=HEAD:refs/heads/main`;
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main`;

export function handleInfoRefs(repo: Repo, service: string, protocolV2: boolean): GitResult {
  if (service === 'git-upload-pack') {
    if (protocolV2) return ok('application/x-git-upload-pack-advertisement', v2Advertisement());
    return ok('application/x-git-upload-pack-advertisement', v0Advertisement(repo, 'git-upload-pack', UPLOAD_V0_CAPS));
  }
  if (service === 'git-receive-pack') {
    return ok('application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack', RECEIVE_V0_CAPS));
  }
  return err(400, `unknown service ${service}`);
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: Buffer[] = [];
  const head = repo.headOid();
  if (matches('HEAD')) {
    if (head !== undefined) {
      lines.push(pktLine(`${head} HEAD${wantSymrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    } else if (wantUnborn) {
      lines.push(pktLine(`unborn HEAD${wantSymrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
  }
  for (const { name, oid } of repo.sortedRefs()) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (wantPeel) {
      const peeled = repo.peel(oid);
      if (peeled.isTag) line += ` peeled:${peeled.target}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  return Buffer.concat([...lines, PKT_FLUSH]);
}

// ---------------------------------------------------------------------------
// fetch (shared computation)
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen?: number;
}

interface FetchResult {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

function computeFetch(repo: Repo, req: FetchRequest): FetchResult {
  const shallowSet = new Set(req.shallow);
  // What the client already holds: closure of its haves, stopping at its
  // shallow boundaries (it holds the boundary commit, not its parents).
  const haveClosure = repo.collectClosure(req.haves, { shallowBoundaries: shallowSet });
  const haveObjects = haveClosure.objects;

  // Objects to send.
  let sendSet: Set<string>;
  let boundary: string[] = [];
  if (req.deepen !== undefined) {
    const res = repo.collectClosure(req.wants, { depth: req.deepen, shallowBoundaries: shallowSet });
    sendSet = res.objects;
    boundary = res.boundary;
  } else {
    sendSet = repo.collectClosure(req.wants, { shallowBoundaries: shallowSet }).objects;
  }

  // Tag wants: a tag object is not a commit, so collectClosure skips it; add
  // the tag itself and the closure of its target.
  for (const want of req.wants) {
    const obj = repo.getObject(want);
    if (obj && obj.type === 'tag') {
      sendSet.add(want);
      // The target's closure was already collected if the target is a commit
      // in the wants; if not, collect it now (depth-limited by the same rule).
      const peeled = repo.peel(want);
      if (peeled.target !== want) {
        const extra = repo.collectClosure([peeled.target], req.deepen !== undefined ? { depth: req.deepen } : {});
        for (const o of extra.objects) sendSet.add(o);
      }
    }
  }

  const objects: GitObject[] = [];
  for (const oid of sendSet) {
    if (haveObjects.has(oid)) continue;
    const obj = repo.getObject(oid);
    if (obj) objects.push(obj);
  }

  // shallow-info: the new boundary commits are `shallow`; old shallow
  // boundaries that are now fully included (in the send set, not a boundary
  // any more) are `unshallow`. The send set is judged before subtracting the
  // client's haves: a boundary the client already holds can still be
  // unshallowed by this fetch.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (req.deepen !== undefined) {
    shallow.push(...boundary);
    const sendCommits = new Set([...sendSet].filter((oid) => repo.getObject(oid)?.type === 'commit'));
    for (const s of req.shallow) {
      if (sendCommits.has(s) && !boundary.includes(s)) unshallow.push(s);
    }
  } else if (req.shallow.length > 0) {
    // No deepen: the client's shallow boundaries stay shallow.
    const sendCommits = new Set([...sendSet].filter((oid) => repo.getObject(oid)?.type === 'commit'));
    for (const s of req.shallow) if (sendCommits.has(s)) shallow.push(s);
  }
  return { objects, shallow, unshallow };
}

function v2FetchResponse(result: FetchResult): Buffer {
  const parts: Buffer[] = [
    pktLine('acknowledgments\n'),
    pktLine('NAK\n'),
    pktLine('ready\n'),
    PKT_DELIM,
  ];
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of result.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of result.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sideband(1, writePack(result.objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v0FetchResponse(result: FetchResult): Buffer {
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const s of result.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of result.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  parts.push(...sideband(1, writePack(result.objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack entry point
// ---------------------------------------------------------------------------

function parseV2Args(packets: Pkt[]): { command: string; args: string[] } | undefined {
  // Section 0 (up to delim): command=..., agent=..., object-format=...
  // Section 1 (up to flush): the command's arguments.
  const sections: string[][] = [];
  let current: string[] = [];
  for (const p of packets) {
    if (p.kind === 'data') {
      current.push(p.data.toString('utf8').replace(/\n$/, ''));
    } else {
      sections.push(current);
      current = [];
      if (p.kind === 'flush') break;
    }
  }
  if (sections.length === 0) return undefined;
  const head = sections[0];
  const cmdLine = head.find((l) => l.startsWith('command='));
  if (!cmdLine) return undefined;
  const command = cmdLine.slice('command='.length);
  const args = sections.length > 1 ? sections[1] : [];
  return { command, args };
}

export function handleUploadPack(repo: Repo, body: Buffer, protocolV2: boolean): GitResult {
  let packets: Pkt[];
  try {
    packets = decodePktLines(body);
  } catch (e) {
    return err(400, `malformed pkt-line stream: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (protocolV2) {
    const parsed = parseV2Args(packets);
    if (!parsed) return err(400, 'malformed v2 request');
    if (parsed.command === 'ls-refs') {
      return ok('application/x-git-upload-pack-result', handleLsRefs(repo, parsed.args));
    }
    if (parsed.command === 'fetch') {
      const req: FetchRequest = { wants: [], haves: [], shallow: [] };
      for (const a of parsed.args) {
        if (a.startsWith('want ')) req.wants.push(a.slice(5).trim());
        else if (a.startsWith('have ')) req.haves.push(a.slice(5).trim());
        else if (a.startsWith('shallow ')) req.shallow.push(a.slice(8).trim());
        else if (a.startsWith('deepen ')) req.deepen = parseInt(a.slice(7), 10);
      }
      if (req.wants.length === 0) return err(400, 'fetch without wants');
      const result = computeFetch(repo, req);
      return ok('application/x-git-upload-pack-result', v2FetchResponse(result));
    }
    return err(400, `unknown v2 command ${parsed.command}`);
  }
  // v0 fetch: want/have/shallow/deepen lines, flush, have lines, done, flush.
  // Note the first `want` line carries the negotiated capabilities space-
  // separated after the oid (not after a NUL): only the first token is the oid.
  const req: FetchRequest = { wants: [], haves: [], shallow: [] };
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.data.toString('utf8').replace(/\n$/, '');
    const clean = line.includes('\0') ? line.slice(0, line.indexOf('\0')) : line;
    if (clean.startsWith('want ')) req.wants.push(clean.slice(5).trim().split(' ')[0]);
    else if (clean.startsWith('have ')) req.haves.push(clean.slice(5).trim().split(' ')[0]);
    else if (clean.startsWith('shallow ')) req.shallow.push(clean.slice(8).trim().split(' ')[0]);
    else if (clean.startsWith('deepen ')) req.deepen = parseInt(clean.slice(7), 10);
  }
  if (req.wants.length === 0) return err(400, 'fetch without wants');
  const result = computeFetch(repo, req);
  return ok('application/x-git-upload-pack-result', v0FetchResponse(result));
}

// ---------------------------------------------------------------------------
// receive-pack (push)
// ---------------------------------------------------------------------------

/**
 * Split a receive-pack body into the pkt-lined command section (up to the
 * first flush) and the raw pack bytes that follow it.
 */
function splitReceivePack(body: Buffer): { commands: Pkt[]; pack: Buffer } | undefined {
  let pos = 0;
  const commands: Pkt[] = [];
  while (pos < body.length) {
    if (pos + 4 > body.length) return undefined;
    const hex = body.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
    const len = parseInt(hex, 16);
    if (len === 0) {
      return { commands, pack: body.subarray(pos + 4) };
    }
    if (len === 1 || len === 2 || len < 4 || pos + len > body.length) return undefined;
    commands.push({ kind: 'data', data: body.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return undefined;
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: Repo, body: Buffer): GitResult {
  const split = splitReceivePack(body);
  if (!split) return err(400, 'malformed receive-pack request');
  const commands: PushCommand[] = [];
  let capabilities = '';
  for (const p of split.commands) {
    const line = p.data.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    if (nul >= 0 && capabilities === '') capabilities = line.slice(nul + 1);
    const parts = clean.split(' ');
    if (parts.length < 3) return err(400, 'malformed push command line');
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  const sidebandOn = capabilities.split(' ').includes('side-band-64k');

  // Unpack the pack (present for creates/updates; absent for delete-only).
  let unpackError: string | undefined;
  if (split.pack.length > 0) {
    try {
      const objects = readPack(split.pack);
      for (const obj of objects) repo.putObject(obj);
    } catch (e) {
      unpackError = e instanceof Error ? e.message : String(e);
    }
  }

  const reportLines: string[] = [];
  if (unpackError !== undefined) {
    reportLines.push(`unpack error ${unpackError}`);
    for (const c of commands) reportLines.push(`ng ${c.ref} unpack failed`);
  } else {
    reportLines.push('unpack ok');
    for (const c of commands) {
      const current = repo.getRef(c.ref);
      const isCreate = isZeroOid(c.oldOid);
      const isDelete = isZeroOid(c.newOid);
      if (isCreate && isDelete) {
        reportLines.push(`ng ${c.ref} invalid command`);
        continue;
      }
      if (isCreate) {
        if (current !== undefined) {
          reportLines.push(`ng ${c.ref} already exists`);
          continue;
        }
        if (!isDelete && repo.getObject(c.newOid) === undefined) {
          reportLines.push(`ng ${c.ref} missing object`);
          continue;
        }
        repo.setRef(c.ref, c.newOid);
        reportLines.push(`ok ${c.ref}`);
        continue;
      }
      if (isDelete) {
        if (current === undefined) {
          reportLines.push(`ng ${c.ref} remote ref does not exist`);
          continue;
        }
        if (current !== c.oldOid) {
          reportLines.push(`ng ${c.ref} non-fast-forward`);
          continue;
        }
        repo.deleteRef(c.ref);
        reportLines.push(`ok ${c.ref}`);
        continue;
      }
      // Update.
      if (current === undefined) {
        reportLines.push(`ng ${c.ref} remote ref does not exist`);
        continue;
      }
      if (current !== c.oldOid) {
        reportLines.push(`ng ${c.ref} non-fast-forward`);
        continue;
      }
      if (c.newOid === c.oldOid) {
        reportLines.push(`ok ${c.ref}`);
        continue;
      }
      if (repo.getObject(c.newOid) === undefined) {
        reportLines.push(`ng ${c.ref} missing object`);
        continue;
      }
      if (!repo.isAncestor(c.oldOid, c.newOid)) {
        reportLines.push(`ng ${c.ref} non-fast-forward`);
        continue;
      }
      repo.setRef(c.ref, c.newOid);
      reportLines.push(`ok ${c.ref}`);
    }
  }

  const inner = Buffer.concat(reportLines.map((l) => pktLine(`${l}\n`)));
  // Inner flush is the raw '0000' bytes inside band 1 (not a pkt-line of '0000').
  const innerWithFlush = Buffer.concat([inner, PKT_FLUSH]);
  let out: Buffer;
  if (sidebandOn) {
    out = Buffer.concat([...sideband(1, innerWithFlush), PKT_FLUSH]);
  } else {
    out = Buffer.concat([inner, PKT_FLUSH]);
  }
  return ok('application/x-git-receive-pack-result', out);
}
