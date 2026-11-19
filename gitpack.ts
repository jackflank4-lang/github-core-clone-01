// gitpack.ts — git object model, pkt-line codec, packfile read/write.
// Pure functions over Buffers; no I/O, no state. Written from scratch for
// the github-core-clone-01 forge (Node 22, stdlib only).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
  oid: string;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** SHA-1 hex of a buffer. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of `<type> <len>\0<data>`. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Build a GitObject (computes the oid) from a type and raw bytes. */
export function makeObject(type: ObjType, data: Buffer): GitObject {
  return { type, data, oid: hashObject(type, data) };
}

// ---------------------------------------------------------------------------
// pkt-line codec (git protocol framing)
// ---------------------------------------------------------------------------

/** Encode one pkt-line: 4-hex length (including the header) + payload. */
export function pktLine(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

export type Pkt =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/**
 * Decode a whole pkt-line stream. Throws on malformed input (bad hex length,
 * truncated packet, overlong packet). A `data` packet's payload is returned
 * verbatim (including any trailing '\n' the writer put there).
 */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line header');
    const hex = buf.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`invalid pkt-line length ${JSON.stringify(hex)}`);
    const len = parseInt(hex, 16);
    if (len === 0) {
      out.push({ kind: 'flush' });
      pos += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'end' });
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) throw new Error('pkt-line length out of range');
    out.push({ kind: 'data', data: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return out;
}

/** Encode data as sideband packets (band byte + payload), each ≤ 65515 bytes of data. */
export function sideband(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  if (data.length === 0) {
    out.push(pktLine(Buffer.from([band])));
    return out;
  }
  for (let i = 0; i < data.length; i += CHUNK) {
    const chunk = data.subarray(i, Math.min(data.length, i + CHUNK));
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    out.push(pktLine(payload));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Packfiles (v2; no deltas on write, plain objects on read)
// ---------------------------------------------------------------------------

/** Serialize objects into a packfile (PACK v2 + entries + SHA-1 trailer). */
export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    // varint header: first byte [cont][type:3][size low 4], then 7-bit groups.
    const size = obj.data.length;
    const typeCode = TYPE_CODE[obj.type];
    const first = ((size & 0x0f) | (typeCode << 4)) & 0xff;
    let rest = size >> 4;
    const headerBytes: number[] = [rest > 0 ? first | 0x80 : first];
    while (rest > 0) {
      const b = rest & 0x7f;
      rest >>= 7;
      headerBytes.push(rest > 0 ? b | 0x80 : b);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Find the end of the zlib stream starting at `pos` (Node's inflateSync
 * ignores trailing bytes and throws on a truncated stream, so the predicate
 * "inflates to exactly `size` bytes" is monotone and binary search finds the
 * first length that works — the true end of the stream).
 */
function zlibStreamEnd(buf: Buffer, pos: number, end: number, size: number): number {
  const ok = (n: number): boolean => {
    try {
      const out = inflateSync(buf.subarray(pos, pos + n));
      return out.length === size;
    } catch {
      return false;
    }
  };
  let lo = 1;
  let hi = end - pos;
  if (!ok(hi)) throw new Error('zlib stream does not terminate');
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return pos + lo;
}

/** Parse a packfile; returns objects in pack order. Throws on bad checksum or deltas. */
export function readPack(buf: Buffer): GitObject[] {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const expect = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!expect.equals(trailer)) throw new Error('pack checksum mismatch');
  const objects: GitObject[] = [];
  let pos = 12;
  const end = buf.length - 20;
  for (let i = 0; i < count; i += 1) {
    if (pos >= end) throw new Error('pack truncated');
    const first = buf[pos];
    pos += 1;
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let cont = first & 0x80;
    while (cont) {
      if (pos >= end) throw new Error('pack truncated in header');
      const b = buf[pos];
      pos += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
      cont = b & 0x80;
    }
    const type = CODE_TYPE[typeCode];
    if (type === undefined) throw new Error(`unsupported pack entry type ${typeCode} (delta packs are not accepted)`);
    const streamEnd = zlibStreamEnd(buf, pos, end, size);
    const data = inflateSync(buf.subarray(pos, streamEnd));
    pos = streamEnd;
    objects.push(makeObject(type, data));
  }
  return objects;
}

// ---------------------------------------------------------------------------
// Trees, commits, tags
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string; // e.g. '100644', '40000' (dir, no leading zero)
  name: string;
  oid: string;
}

/** Git's tree sort: compare names as bytes, treating a directory as name + '/'. */
export function compareTreeNames(aName: string, aIsDir: boolean, bName: string, bIsDir: boolean): number {
  const a = aIsDir ? `${aName}/` : aName;
  const b = bIsDir ? `${bName}/` : bName;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return Buffer.compare(ab, bb);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) throw new Error('bad tree entry');
    const mode = data.subarray(pos, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('bad tree entry');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    pos = nul + 21;
  }
  return out;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    compareTreeNames(a.name, a.mode === '40000', b.name, b.mode === '40000'),
  );
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  raw: Buffer;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, raw: data };
}

export function buildCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${author}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerText = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}
