// gitobj.ts — git object, pack and pkt-line primitives for the forge.
// Written fresh in this session from the git smart-HTTP wire format.
// Stdlib only: node:crypto, node:zlib.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** SHA-1 of `<type> <size>\0<data>` — the git object id. */
export function hashObject(type: GitObjectType, data: Buffer | Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const head = Buffer.from(`${type} ${body.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(body).digest('hex');
}

/** The canonical loose-object header bytes for an object. */
export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\0`, 'utf8');
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode');
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('tree entry oid is truncated');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries ordered by name, directories compared as name + '/'. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  const key = (entry: TreeEntry): string => (entry.mode === '40000' ? `${entry.name}/` : entry.name);
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Serialise tree entries (sorted git-style) into tree object bytes. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Commits and tags
// ---------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's bytes. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object's bytes. */
export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Build a commit object's bytes. Identity is `Name <email>`, timestamp is unix seconds. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}): Buffer {
  const timestamp = fields.timestamp ?? Math.floor(Date.now() / 1000);
  const author = fields.author ?? 'ada iversen <adaiversen@example.invalid>';
  const committer = fields.committer ?? author;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${author} ${timestamp} +0000`, `committer ${committer} ${timestamp} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger?: string;
  timestamp?: number;
}): Buffer {
  const timestamp = fields.timestamp ?? Math.floor(Date.now() / 1000);
  const tagger = fields.tagger ?? 'ada iversen <adaiversen@example.invalid>';
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger} ${timestamp} +0000\n\n${fields.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Pkt-lines
// ---------------------------------------------------------------------------

export const PKT_LINE_MAX = 65520;

/** One pkt-line framing `payload` (a string is UTF-8). */
export function encodePktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > PKT_LINE_MAX) throw new Error(`pkt-line of ${length} bytes exceeds ${PKT_LINE_MAX}`);
  const head = Buffer.alloc(4);
  head.write(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** A flush pkt-line (`0000`). */
export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** A delim pkt-line (`0001`). */
export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** A response-end pkt-line (`0002`). */
export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export type GitPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Decode a whole buffer of pkt-lines. Returns the packets; throws on a malformed line.
 * A trailing raw tail (the pack after a flush in a receive-pack body) is returned as `tail`.
 */
export function decodePktLines(buffer: Buffer): { packets: GitPacket[]; tail: Buffer } {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line header is truncated');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      // Not a pkt-line at all: the rest is raw data (a pack after the flush).
      return { packets, tail: buffer.subarray(offset) };
    }
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line length is out of range');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, tail: Buffer.alloc(0) };
}

// ---------------------------------------------------------------------------
// Deltas and packs
// ---------------------------------------------------------------------------

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

function readVarintSize(buffer: Buffer, offset: number): { first: number; size: number; next: number } {
  const first = buffer[offset];
  let size = first & 0x0f;
  let shift = 4;
  let next = offset + 1;
  while ((buffer[next - 1] & 0x80) !== 0) {
    const byte = buffer[next];
    if (byte === undefined) throw new Error('pack object header is truncated');
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    next += 1;
  }
  return { first, size, next };
}

function readOfsDeltaBase(buffer: Buffer, offset: number): { baseOffset: number; next: number } {
  let byte = buffer[offset];
  if (byte === undefined) throw new Error('ofs-delta base offset is truncated');
  let baseOffset = byte & 0x7f;
  let next = offset + 1;
  while ((byte & 0x80) !== 0) {
    byte = buffer[next];
    if (byte === undefined) throw new Error('ofs-delta base offset is truncated');
    baseOffset = ((baseOffset + 1) << 7) + (byte & 0x7f);
    next += 1;
  }
  return { baseOffset, next };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

export interface PackReadResult {
  version: number;
  declaredCount: number;
  objects: Map<string, GitObject>;
  deltaCount: number;
  checksumOk: boolean;
}

/**
 * Read a packfile (version 2 or 3), resolving OFS_DELTA and REF_DELTA entries.
 * `resolveBase` supplies a base object a thin pack leaves out. Every object's SHA-1 is
 * recomputed and its declared size checked; a mismatch throws.
 */
export function readPack(pack: Buffer, options: { resolveBase?: (oid: string) => GitObject | undefined } = {}): PackReadResult {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  const checksumOk = trailer === computedTrailer;
  if (!checksumOk) throw new Error('pack trailer does not match its bytes');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset`);
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  let deltaCount = 0;
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { version, declaredCount, objects, deltaCount, checksumOk };
}

/** Encode one pack entry header: the type in bits 4-6 of the first byte, the size low 4 bits. */
function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const typeCode = TYPE_CODE[type];
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  let rest = size >>> 4;
  if (rest > 0) first |= 0x80;
  bytes.push(first);
  while (rest > 0) {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/**
 * Write a packfile (version 2) of plain objects — no deltas. The entries are ordered by
 * object id so the output is deterministic.
 */
export function writePack(objects: Iterable<{ type: GitObjectType; data: Buffer }>): Buffer {
  const list = [...objects].sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** The 32-byte empty pack (header + trailer, zero objects). */
export function writeEmptyPack(): Buffer {
  return writePack([]);
}
