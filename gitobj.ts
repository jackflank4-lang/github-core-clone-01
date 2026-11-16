// gitobj.ts — the git object model: SHA-1 ids, object parsing, packfile read/write
// (plain objects plus OFS/REF delta resolution), pkt-line framing, reachability,
// shallow/deepen selection and tree diffs. Standard library only, no git binary.
//
// Every object is stored byte-exact: the id is SHA-1 over "<type> <size>\0" + bytes, so a
// clone that recomputes ids always matches what was pushed.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

/** SHA-1 of "<type> <size>\0" + data: the object id git computes. */
export function hashObject(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** A parsed commit: tree, parents, author/committer lines, message. */
export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit's bytes. Throws on a malformed header. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
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
  if (!isOid(tree)) throw new Error('commit has no tree');
  return { tree, parents, author, committer, message };
}

/** A parsed tag: target object, its type, the tag name, tagger line, message. */
export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree's bytes into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) throw new Error('malformed tree entry');
    const nul = data.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree entry');
    entries.push({
      mode: data.subarray(off, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

/** Build a tree's bytes from entries (callers keep git's sort order). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git's tree sort key: a directory name compares as if it ended in '/'. */
export function treeSortKey(name: string, mode: string): string {
  return mode === '40000' ? `${name}/` : name;
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export const PKT_LINE_MAX = 65520;

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Encode one data pkt-line (payload + trailing newline is the caller's). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  if (len > PKT_LINE_MAX) throw new Error('pkt-line too long');
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

/** Decode a whole buffer of pkt-lines. Throws on a malformed line. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line length');
    const lenText = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(lenText)) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    const len = parseInt(lenText, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('pkt-line overruns its buffer');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

/** Split a request body into its pkt-lines and the raw bytes after the first flush. */
export function splitPktBody(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  let off = 0;
  const packets: Pkt[] = [];
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line length');
    const lenText = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(lenText)) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    const len = parseInt(lenText, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, rest: buf.subarray(off + 4) };
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('pkt-line overruns its buffer');
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: Buffer.alloc(0) };
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

const PACK_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Write a packfile (version 2, plain objects, no deltas) for `objects`. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const chunks: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  chunks.push(head);
  for (const object of objects) {
    const typeCode = PACK_TYPE_CODES[object.type];
    const size = object.data.length;
    // Varint header: low 4 bits of size in the first byte, then 7 bits per byte.
    const headerBytes: number[] = [];
    let remaining = size;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining >>>= 4;
    while (remaining > 0) {
      headerBytes.push(first | 0x80);
      first = remaining & 0x7f;
      remaining >>>= 7;
    }
    headerBytes.push(first);
    chunks.push(Buffer.from(headerBytes));
    chunks.push(deflateSync(object.data));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Verify a packfile's trailer SHA-1. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 32) return { ok: false, expected: '', actual: '' };
  const expected = pack.subarray(pack.length - 20).toString('hex');
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return { ok: expected === actual, expected, actual };
}

interface PackEntry {
  type: GitObjectType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  /** OFS_DELTA: negative offset to the base entry. REF_DELTA: base oid. */
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Find the end of the zlib stream starting at `offset`: inflateSync ignores trailing bytes
 * and throws on truncation, so the stream's end is the smallest prefix that inflates. The
 * search is monotonic, and the window starts at the declared size + 16 (deflate never expands
 * data by more than a few bytes over its input).
 */
function inflateAt(buf: Buffer, offset: number, declaredSize: number): { data: Buffer; consumed: number } {
  // One call, no probing: inflateSync ignores trailing bytes, and with { info: true } the
  // engine reports exactly how many compressed bytes it consumed (bytesWritten). The old
  // binary search threw ~log2(window) errors per entry to find the stream end, and every
  // throw captured a stack trace — the push workload's main hotspot.
  const result = inflateSync(buf.subarray(offset), { info: true });
  const data = result.buffer;
  if (data.length !== declaredSize) throw new Error('pack entry inflated to the wrong size');
  const consumed = result.engine.bytesWritten;
  if (typeof consumed !== 'number' || consumed <= 0 || offset + consumed > buf.length) {
    throw new Error('pack entry: cannot determine compressed length');
  }
  return { data, consumed };
}

/** Apply a git delta to a base object, returning the result bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[off++] ?? 0;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (off < delta.length) {
    const op = delta[off++] ?? 0;
    if ((op & 0x80) !== 0) {
      let copyOff = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) if ((op & (1 << i)) !== 0) copyOff |= (delta[off++] ?? 0) << (8 * i);
      for (let i = 0; i < 3; i += 1) if ((op & (0x10 << i)) !== 0) copySize |= (delta[off++] ?? 0) << (8 * i);
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOff, copyOff + copySize));
      produced += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(off, off + op));
      off += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== resultSize || produced !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

/** Read a packfile into objects. `have` resolves REF_DELTA bases the pack does not carry. */
export function readPack(pack: Buffer, have?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const checksum = verifyPackChecksum(pack);
  if (!checksum.ok) throw new Error('pack checksum mismatch');
  const entries: PackEntry[] = [];
  // Entry offsets, so OFS_DELTA bases resolve by position.
  const offsets: number[] = [];
  let off = 12;
  const end = pack.length - 20;
  for (let i = 0; i < count; i += 1) {
    if (off >= end) throw new Error('pack ends before its declared count');
    offsets.push(off);
    let byte = pack[off++] ?? 0;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[off++] ?? 0;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: variable-length negative offset.
      byte = pack[off++] ?? 0;
      let value = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[off++] ?? 0;
        value = ((value + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = offsets[i]! - value;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const { data, consumed } = inflateAt(pack, off, size);
    if (data.length !== size) throw new Error('pack entry size mismatch');
    off += consumed;
    if (typeCode === 6) entries.push({ type: 'ofs-delta', data, baseOffset });
    else if (typeCode === 7) entries.push({ type: 'ref-delta', data, baseOid });
    else {
      const type = PACK_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      entries.push({ type, data });
    }
  }
  // Resolve deltas in entry order (a delta's base always precedes it in a valid pack).
  const objects = new Map<string, GitObject>();
  const resolved: Array<GitObject | null> = entries.map(() => null);
  const byOffset = new Map<number, GitObject>();
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let base: GitObject | undefined;
      if (entry.type === 'ofs-delta' && entry.baseOffset !== undefined) base = byOffset.get(entry.baseOffset);
      if (entry.type === 'ref-delta' && entry.baseOid !== undefined) {
        base = objects.get(entry.baseOid) ?? (have !== undefined ? have(entry.baseOid) : undefined);
      }
      if (base === undefined) throw new Error('delta base not found');
      const data = applyDelta(base.data, entry.data);
      const object: GitObject = { type: base.type, data };
      resolved[i] = object;
      byOffset.set(offsets[i]!, object);
      objects.set(hashObject(object.type, data), object);
    } else {
      const object: GitObject = { type: entry.type, data: entry.data };
      resolved[i] = object;
      byOffset.set(offsets[i]!, object);
      objects.set(hashObject(object.type, entry.data), object);
    }
  }
  return objects;
}

// ---------------------------------------------------------------------------
// reachability and shallow selection
// ---------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** All oids reachable from `roots` (commits, tags, trees, blobs). Throws on a missing object. */
export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
  return seen;
}

/**
 * The closure of `tips`, but a traversal never descends past a commit in `cutoff`: its parents
 * are not held by the client, so they are not excluded by a have. Used for the fetch exclusion
 * set (reachable(haves) minus what a shallow client does not hold).
 */
export function collectHeld(roots: Iterable<string>, lookup: ObjectLookup, cutoff: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!cutoff.has(oid)) for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
  return seen;
}

export interface FetchSelection {
  /** Objects to send, in a stable order (commits, trees, blobs as encountered). */
  objects: GitObject[];
  /** New shallow boundaries (commits at depth-1 whose parents were cut off). */
  shallow: string[];
  /** Previously-shallow commits that are now fully held. */
  unshallow: string[];
}

/**
 * Select what a fetch sends: reachable(wants) minus reachable(haves), honouring `depth`.
 * `clientShallow` is the set the client already holds as shallow (its `shallow` request lines).
 */
export function selectFetch(
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  clientShallow: ReadonlySet<string>,
  lookup: ObjectLookup,
): FetchSelection {
  // BFS over commit parents from the wants, tracking distance.
  const includedCommits = new Map<string, number>(); // oid -> distance
  const queue: Array<{ oid: string; distance: number }> = [];
  for (const want of wants) {
    const object = lookup(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      queue.push({ oid: target, distance: 0 });
      includedCommits.set(target, 0);
    } else if (object.type === 'commit') {
      queue.push({ oid: want, distance: 0 });
      includedCommits.set(want, 0);
    } else {
      // A want naming a tree or blob directly: send it as-is.
      includedCommits.set(want, 0);
    }
  }
  const shallow: string[] = [];
  const boundary = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const { oid, distance } = queue[head++]!;
    if (depth !== null && distance >= depth) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (depth !== null && distance === depth - 1) {
      if (commit.parents.length > 0) boundary.add(oid);
      continue;
    }
    for (const parent of commit.parents) {
      if (!includedCommits.has(parent)) {
        includedCommits.set(parent, distance + 1);
        queue.push({ oid: parent, distance: distance + 1 });
      }
    }
  }
  for (const oid of boundary) shallow.push(oid);
  // Unshallow: a previously-shallow commit that is now included strictly inside the boundary.
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    const distance = includedCommits.get(oid);
    if (distance !== undefined && (depth === null || distance < depth - 1)) unshallow.push(oid);
  }
  // Expand the included commits to their full closure, then subtract what the client holds.
  const wanted = new Set<string>();
  for (const want of wants) {
    const object = lookup(want);
    if (object !== undefined) wanted.add(want);
  }
  const closure = new Set<string>();
  const stack: string[] = [];
  for (const oid of includedCommits.keys()) stack.push(oid);
  for (const want of wanted) {
    const object = lookup(want);
    if (object !== undefined && object.type !== 'commit') stack.push(want);
  }
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (closure.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    closure.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
  const held = collectHeld(haves, lookup, clientShallow);
  const send = new Set<string>();
  for (const oid of closure) if (!held.has(oid)) send.add(oid);
  // A want that is itself a tag: the tag object must be sent even when its target is held.
  for (const want of wanted) {
    const object = lookup(want);
    if (object !== undefined && object.type === 'tag') send.add(want);
  }
  // Order deterministically: commits first (parents after children), then trees, then blobs.
  const objects: GitObject[] = [];
  const byType = (type: GitObjectType): GitObject[] => {
    const list: GitObject[] = [];
    for (const oid of send) {
      const object = lookup(oid);
      if (object !== undefined && object.type === type) list.push(object);
    }
    return list;
  };
  objects.push(...byType('commit'), ...byType('tag'), ...byType('tree'), ...byType('blob'));
  return { objects, shallow, unshallow };
}

/** Peel a ref's oid to the commit it ultimately names (tags resolve through). */
export function peelToCommit(oid: string, lookup: ObjectLookup): string | null {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const object = lookup(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** The merge base of two commits: the newest common ancestor (by first-parent walk + BFS). */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  const ancestorsA = new Set<string>();
  const queueA: string[] = [a];
  while (queueA.length > 0) {
    const oid = queueA.pop()!;
    if (ancestorsA.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    ancestorsA.add(oid);
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const queueB: string[] = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const oid = queueB.pop()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

/** Is `ancestor` reachable from `tip` (a fast-forward check)? */
export function isAncestor(ancestor: string, tip: string, lookup: ObjectLookup): boolean {
  if (ancestor === tip) return true;
  const stack: string[] = [tip];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** Flatten a tree to path -> {oid, mode} (recursive, '/'-joined paths). */
export function flattenTree(treeOid: string, lookup: ObjectLookup): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** A one-line diff between two blobs, for pull-request file stats. */
export function lineDiffCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
  // Drop the trailing empty element a final newline creates, on both sides.
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  // LCS on lines (files here are small; the DP table stays tiny).
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = [];
  for (let i = 0; i <= m; i += 1) dp.push(new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return { additions: n - common, deletions: m - common };
}
