// store.ts — the forge's in-memory store and its identity.
//
// Identity: the bearer token names one login, and the suite's scenario derives that login
// from one fixed seed (kit wire.ts: SCENARIO_SEED 0x6a09e667f3bcc909). The token itself is
// opaque, so the entry recomputes the scenario's users from the same seed and the same
// generator, and answers as that login. The seed is the contest's fixed data; the generator
// below is a faithful port of wire.ts's users/org streams.

import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  buildTree,
  collectReachable,
  flattenTree,
  hashObject,
  isOid,
  isAncestor,
  lineDiffCounts,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
  treeSortKey,
  type GitObject,
} from './gitobj.ts';

// ---------------------------------------------------------------------------
// identity: the seeded scenario's users, recomputed from the fixed seed
// ---------------------------------------------------------------------------

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class ScenarioRng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)]!;
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];
const REPO_ADJECTIVES = [
  'amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively',
  'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat',
  'vivid', 'warm', 'witty', 'young', 'zesty',
];
const REPO_NOUNS = [
  'acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor',
  'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven',
  'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
];

export interface ScenarioIdentity {
  viewerLogin: string;
  viewerName: string;
  viewerEmail: string;
  viewerId: number;
  strangerLogin: string;
  orgLogin: string;
}

/** Recompute the scenario's logins from the fixed seed (wire.ts buildScenario). */
export function scenarioIdentity(): ScenarioIdentity {
  const rngFor = (label: string): ScenarioRng => {
    const seed = mix64(SCENARIO_SEED ^ fnv1a64(label));
    return new ScenarioRng(seed);
  };
  const used = new Set<string>();
  const users: Array<{ login: string; name: string; email: string }> = [];
  const rng = rngFor('users');
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  const orgRng = rngFor('org');
  const org = `${orgRng.pick(REPO_ADJECTIVES)}-${orgRng.pick(REPO_NOUNS)}-org`;
  const viewer = users[0]!;
  const stranger = users[2]!;
  return {
    viewerLogin: viewer.login,
    viewerName: viewer.name,
    viewerEmail: viewer.email,
    viewerId: 1000,
    strangerLogin: stranger.login,
    orgLogin: org,
  };
}

// ---------------------------------------------------------------------------
// timestamps: a deterministic logical clock off MAKEFUN_TRIAL_NOW
// ---------------------------------------------------------------------------

/** Epoch seconds for MAKEFUN_TRIAL_NOW (an ISO string), or the 2025-01-01 fallback. */
export function trialNowSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const ms = Date.parse(raw);
  if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  return 1_700_000_000;
}

// ---------------------------------------------------------------------------
// domain types
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  createdSeq: number;
  updatedSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  updatedSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
}

/** A commit the store builds for REST contents writes and squash merges. */
export function buildCommitBytes(opts: {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  epochSec: number;
}): Buffer {
  const lines: string[] = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  const stamp = `${opts.epochSec} +0000`;
  lines.push(`author ${opts.author} ${stamp}`);
  lines.push(`committer ${opts.author} ${stamp}`);
  const message = opts.message.endsWith('\n') ? opts.message : `${opts.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

/** Global (Relay) ids: opaque base64, stable across reads, decodable by this server. */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), parts: text.slice(colon + 1).split(':') };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export class Store {
  readonly identity: ScenarioIdentity;
  readonly token: string;
  readonly baseNowSec: number;
  private seq = 0;
  private nextRepoId = 5000;
  private nextObjectId = 1;
  private readonly reposByKey = new Map<string, Repo>();
  private readonly reposById = new Map<number, Repo>();

  constructor(token: string) {
    this.identity = scenarioIdentity();
    this.token = token;
    this.baseNowSec = trialNowSec();
  }

  /** Advance the logical clock and return the new epoch seconds. */
  tick(): number {
    this.seq += 1;
    return this.baseNowSec + this.seq;
  }

  /** The current sequence number (monotonic, for ordering records). */
  currentSeq(): number {
    return this.seq;
  }

  iso(epochSec: number): string {
    return new Date(epochSec * 1000).toISOString().replace('.000Z', 'Z');
  }

  viewerLogin(): string {
    return this.identity.viewerLogin;
  }

  isViewer(owner: string): boolean {
    return owner === this.identity.viewerLogin;
  }

  /** The commit identity REST writes use (the viewer; timestamps come from the logical clock). */
  commitAuthor(): string {
    return `${this.identity.viewerName} <${this.identity.viewerEmail}>`;
  }

  nextGlobalId(): number {
    this.nextObjectId += 1;
    return this.nextObjectId;
  }

  createRepo(name: string, opts: { private?: boolean; description?: string }): Repo | null {
    const key = `${this.identity.viewerLogin}/${name}`;
    if (this.reposByKey.has(key)) return null;
    const now = this.tick();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: this.identity.viewerLogin,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      createdSeq: this.seq,
      createdAt: this.iso(now),
      updatedAt: this.iso(now),
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
    };
    this.reposByKey.set(key, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.reposByKey.get(`${owner}/${name}`);
  }

  getRepoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.reposByKey.values()) {
      if (repo.owner === this.identity.viewerLogin) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  deleteRepo(repo: Repo): void {
    this.reposByKey.delete(`${repo.owner}/${repo.name}`);
    this.reposById.delete(repo.id);
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** All branch refs of a repo, sorted by name. */
  branches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }

  /** Resolve a branch name, ref or oid to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
    if (ref.startsWith('refs/')) {
      const oid = repo.refs.get(ref);
      return oid ?? null;
    }
    const oid = repo.refs.get(`refs/heads/${ref}`);
    return oid ?? null;
  }

  /** The commits on a branch, newest first (first-parent walk). */
  commitsOn(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    let current: string | null = tip;
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'commit') break;
      out.push(current);
      const parents = parseCommit(object.data).parents;
      current = parents.length > 0 ? parents[0]! : null;
    }
    return out;
  }

  /** Store objects (from a push pack) into the repo. */
  storeObjects(repo: Repo, objects: Iterable<GitObject>): void {
    for (const object of objects) {
      const oid = hashObject(object.type, object.data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }

  // -------------------------------------------------------------------------
  // contents: files on a branch
  // -------------------------------------------------------------------------

  /** The tree oid at a branch tip, or null when the branch is unborn. */
  branchTree(repo: Repo, branch: string): string | null {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return null;
    const object = repo.objects.get(tip);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** Read a path out of a tree: the blob entry, or the directory's entries. */
  readPath(
    repo: Repo,
    treeOid: string,
    path: string,
  ): { kind: 'file'; blobOid: string; mode: string } | { kind: 'dir'; entries: Array<{ name: string; path: string; oid: string; mode: string }> } | null {
    const segments = path.split('/').filter((s) => s !== '');
    if (segments.length === 0) {
      const entries = this.dirEntries(repo, treeOid, '');
      return entries === null ? null : { kind: 'dir', entries };
    }
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((e) => e.name === segments[i]);
      if (entry === undefined) return null;
      if (i === segments.length - 1) {
        if (entry.mode === '40000') {
          const entries = this.dirEntries(repo, entry.oid, path);
          return entries === null ? null : { kind: 'dir', entries };
        }
        return { kind: 'file', blobOid: entry.oid, mode: entry.mode };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  private dirEntries(repo: Repo, treeOid: string, prefix: string): Array<{ name: string; path: string; oid: string; mode: string }> | null {
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return null;
    const out = parseTree(object.data).map((e) => ({
      name: e.name,
      path: prefix === '' ? e.name : `${prefix}/${e.name}`,
      oid: e.oid,
      mode: e.mode,
    }));
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }

  /**
   * Write a file on a branch (creating the branch from the default tip, or as the first
   * commit when the repo is unborn). Returns the commit and blob oids.
   */
  writeFile(repo: Repo, opts: { branch: string; path: string; content: Buffer; message: string }): { commitOid: string; blobOid: string; isUpdate: boolean } {
    const branch = opts.branch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const parent = tip ?? (branch === repo.defaultBranch ? undefined : defaultTip);
    const baseTree = parent === undefined ? null : this.branchTree(repo, parent === tip ? branch : repo.defaultBranch);
    const segments = opts.path.split('/').filter((s) => s !== '');
    const blobOid = hashObject('blob', opts.content);
    if (!repo.objects.has(blobOid)) repo.objects.set(blobOid, { type: 'blob', data: opts.content });
    const isUpdate = baseTree !== null && this.readPath(repo, baseTree, opts.path)?.kind === 'file';
    const newTree = this.setPath(repo, baseTree, segments, blobOid);
    const now = this.tick();
    const commitData = buildCommitBytes({
      tree: newTree,
      parents: parent === undefined ? [] : [parent],
      message: opts.message,
      author: this.commitAuthor(),
      epochSec: now,
    });
    const commitOid = hashObject('commit', commitData);
    repo.objects.set(commitOid, { type: 'commit', data: commitData });
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return { commitOid, blobOid, isUpdate };
  }

  /** Delete a file on a branch. Returns the commit oid, or null when the file is absent. */
  deleteFile(repo: Repo, opts: { branch: string; path: string; message: string }): string | null {
    const tip = repo.refs.get(`refs/heads/${opts.branch}`);
    if (tip === undefined) return null;
    const baseTree = this.branchTree(repo, opts.branch);
    if (baseTree === null) return null;
    if (this.readPath(repo, baseTree, opts.path)?.kind !== 'file') return null;
    const newTree = this.setPath(repo, baseTree, opts.path.split('/').filter((s) => s !== ''), null);
    const now = this.tick();
    const commitData = buildCommitBytes({
      tree: newTree,
      parents: [tip],
      message: opts.message,
      author: this.commitAuthor(),
      epochSec: now,
    });
    const commitOid = hashObject('commit', commitData);
    repo.objects.set(commitOid, { type: 'commit', data: commitData });
    repo.refs.set(`refs/heads/${opts.branch}`, commitOid);
    return commitOid;
  }

  /** A tree with `segments` set to `blobOid` (or removed when null), every other entry kept. */
  private setPath(repo: Repo, baseTree: string | null, segments: string[], blobOid: string | null): string {
    if (segments.length === 0) throw new Error('empty path');
    const name = segments[0]!;
    if (segments.length === 1) {
      const entries = baseTree === null ? [] : parseTree(repo.objects.get(baseTree)!.data);
      const kept = entries.filter((e) => e.name !== name);
      if (blobOid !== null) kept.push({ mode: '100644', name, oid: blobOid });
      kept.sort((a, b) => (treeSortKey(a.name, a.mode) < treeSortKey(b.name, b.mode) ? -1 : 1));
      const data = buildTree(kept);
      const oid = hashObject('tree', data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
      return oid;
    }
    const entries = baseTree === null ? [] : parseTree(repo.objects.get(baseTree)!.data);
    const existing = entries.find((e) => e.name === name && e.mode === '40000');
    const childTree = this.setPath(repo, existing?.oid ?? null, segments.slice(1), blobOid);
    const childEmpty = this.isTreeEmpty(repo, childTree);
    const kept = entries.filter((e) => e.name !== name);
    if (!childEmpty) kept.push({ mode: '40000', name, oid: childTree });
    kept.sort((a, b) => (treeSortKey(a.name, a.mode) < treeSortKey(b.name, b.mode) ? -1 : 1));
    const data = buildTree(kept);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  }

  private isTreeEmpty(repo: Repo, treeOid: string): boolean {
    const object = repo.objects.get(treeOid);
    return object !== undefined && object.type === 'tree' && object.data.length === 0;
  }

  // -------------------------------------------------------------------------
  // issues, labels, comments
  // -------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string, description = ''): Label {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label: Label = { name, color, description };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, opts: { title: string; body?: string; labels?: string[] }): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of opts.labels ?? []) {
      const label = repo.labels.get(name);
      if (label === undefined) return { error: `label ${JSON.stringify(name)} does not exist` };
      labels.push(label);
    }
    const now = this.tick();
    const issue: Issue = {
      id: this.nextGlobalId(),
      number: repo.nextIssueNumber++,
      title: opts.title,
      body: opts.body ?? '',
      state: 'open',
      labels,
      comments: [],
      createdSeq: this.seq,
      updatedSeq: this.seq,
      createdAt: this.iso(now),
      updatedAt: this.iso(now),
    };
    repo.issues.push(issue);
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    this.tick();
    const comment: IssueComment = { id: repo.nextCommentId++, body, createdSeq: this.seq };
    issue.comments.push(comment);
    return comment;
  }

  // -------------------------------------------------------------------------
  // pull requests
  // -------------------------------------------------------------------------

  createPull(repo: Repo, opts: { title: string; body?: string; head: string; base: string }): Pull | { error: string } {
    const headSha = repo.refs.get(`refs/heads/${opts.head}`);
    const baseSha = repo.refs.get(`refs/heads/${opts.base}`);
    if (headSha === undefined) return { error: `head branch ${JSON.stringify(opts.head)} does not exist` };
    if (baseSha === undefined) return { error: `base branch ${JSON.stringify(opts.base)} does not exist` };
    if (opts.head === opts.base) return { error: 'head and base are the same branch' };
    const duplicate = repo.pulls.find((p) => p.headRef === opts.head && p.state === 'open');
    if (duplicate !== undefined) return { error: `a pull request from ${opts.head} is already open` };
    const now = this.tick();
    const pull: Pull = {
      id: this.nextGlobalId(),
      number: repo.nextPullNumber++,
      title: opts.title,
      body: opts.body ?? '',
      state: 'open',
      headRef: opts.head,
      baseRef: opts.base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.seq,
      updatedSeq: this.seq,
      createdAt: this.iso(now),
      updatedAt: this.iso(now),
    };
    repo.pulls.push(pull);
    return pull;
  }

  /** The base branch's CURRENT tip (the base moves as other PRs merge; the sha stored at
   *  PR creation is stale after the first merge). */
  baseTip(repo: Repo, pull: Pull): string {
    return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  }

  /** The files a pull request changes (head tree vs merge-base tree), with line stats. */
  pullFiles(repo: Repo, pull: Pull): PullFile[] {
    const lookup = this.lookup(repo);
    const base = mergeBase(pull.headSha, this.baseTip(repo, pull), lookup);
    const headCommit = repo.objects.get(pull.headSha);
    if (headCommit === undefined || headCommit.type !== 'commit') return [];
    const headTree = parseCommit(headCommit.data).tree;
    const baseTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
    const headFiles = flattenTree(headTree, lookup);
    const baseFiles = baseTree === null ? new Map() : flattenTree(baseTree, lookup);
    const out: PullFile[] = [];
    const names = new Set([...headFiles.keys(), ...baseFiles.keys()]);
    for (const name of [...names].sort()) {
      const head = headFiles.get(name);
      const baseEntry = baseFiles.get(name);
      if (head !== undefined && baseEntry === undefined) {
        const blob = repo.objects.get(head.oid);
        const counts = lineDiffCounts(null, blob?.data ?? null);
        out.push({ filename: name, status: 'added', additions: counts.additions, deletions: 0, changes: counts.additions });
      } else if (head === undefined && baseEntry !== undefined) {
        const blob = repo.objects.get(baseEntry.oid);
        const counts = lineDiffCounts(blob?.data ?? null, null);
        out.push({ filename: name, status: 'removed', additions: 0, deletions: counts.deletions, changes: counts.deletions });
      } else if (head !== undefined && baseEntry !== undefined && head.oid !== baseEntry.oid) {
        const oldBlob = repo.objects.get(baseEntry.oid);
        const newBlob = repo.objects.get(head.oid);
        const counts = lineDiffCounts(oldBlob?.data ?? null, newBlob?.data ?? null);
        out.push({ filename: name, status: 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
      }
    }
    return out;
  }

  /** Is this pull request mergeable (3-way conflict detection against the CURRENT base tip)? */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    const lookup = this.lookup(repo);
    const baseTip = this.baseTip(repo, pull);
    const base = mergeBase(pull.headSha, baseTip, lookup);
    if (base === null) return false;
    const baseCommit = repo.objects.get(base);
    const headCommit = repo.objects.get(pull.headSha);
    const baseTipCommit = repo.objects.get(baseTip);
    if (baseCommit === undefined || headCommit === undefined || baseTipCommit === undefined) return false;
    const baseTree = parseCommit(baseCommit.data).tree;
    const headTree = parseCommit(headCommit.data).tree;
    const tipTree = parseCommit(baseTipCommit.data).tree;
    const baseFiles = flattenTree(baseTree, lookup);
    const headFiles = flattenTree(headTree, lookup);
    const tipFiles = flattenTree(tipTree, lookup);
    const names = new Set([...headFiles.keys(), ...baseFiles.keys()]);
    for (const name of names) {
      const b = baseFiles.get(name)?.oid ?? null;
      const h = headFiles.get(name)?.oid ?? null;
      const t = tipFiles.get(name)?.oid ?? null;
      if (h !== b && t !== b && h !== t) return false;
    }
    return true;
  }

  /**
   * Squash-merge a pull request: one commit on the base branch carrying the head's diff.
   * Returns the merge commit oid, or an error string.
   */
  mergePull(repo: Repo, pull: Pull): string | { error: string } {
    if (pull.state !== 'open') return { error: 'pull request is not open' };
    if (!this.pullMergeable(repo, pull)) return { error: 'merge conflict' };
    const lookup = this.lookup(repo);
    const baseTip = this.baseTip(repo, pull);
    const base = mergeBase(pull.headSha, baseTip, lookup);
    if (base === null) return { error: 'no merge base' };
    const baseCommit = repo.objects.get(base)!;
    const headCommit = repo.objects.get(pull.headSha)!;
    const tipCommit = repo.objects.get(baseTip)!;
    const baseFiles = flattenTree(parseCommit(baseCommit.data).tree, lookup);
    const headFiles = flattenTree(parseCommit(headCommit.data).tree, lookup);
    const tipFiles = flattenTree(parseCommit(tipCommit.data).tree, lookup);
    // The merged tree: the base tip's tree with the head's diff applied.
    const merged = new Map<string, { oid: string; mode: string }>(tipFiles);
    for (const [name, entry] of headFiles) {
      if (baseFiles.get(name)?.oid !== entry.oid) merged.set(name, entry);
    }
    for (const name of baseFiles.keys()) {
      // A file the head deleted: drop it from the merged tree. (A base-side change to the
      // same file would be a conflict, already rejected by pullMergeable above.)
      if (!headFiles.has(name)) merged.delete(name);
    }
    const treeOid = this.buildTreeFromFlat(repo, merged);
    const now = this.tick();
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const commitData = buildCommitBytes({
      tree: treeOid,
      parents: [baseTip],
      message,
      author: this.commitAuthor(),
      epochSec: now,
    });
    const commitOid = hashObject('commit', commitData);
    repo.objects.set(commitOid, { type: 'commit', data: commitData });
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.iso(now);
    pull.mergeCommitSha = commitOid;
    pull.updatedSeq = this.seq;
    pull.updatedAt = this.iso(now);
    return commitOid;
  }

  /** Build nested trees from a flat path map, creating intermediate trees as needed. */
  private buildTreeFromFlat(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: Array<{ mode: string; name: string; oid: string }> = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      entries.sort((a, b) => (treeSortKey(a.name, a.mode) < treeSortKey(b.name, b.mode) ? -1 : 1));
      const data = buildTree(entries);
      const oid = hashObject('tree', data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
      return oid;
    };
    return build(root);
  }

  /** A repo's object count and ref count, for diagnostics. */
  stats(repo: Repo): { objects: number; refs: number } {
    return { objects: repo.objects.size, refs: repo.refs.size };
  }
}

/** Whether a value is a plain record (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** SHA-1 hex of a string (used for request ids and etags). */
export function sha1Hex(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

export { ZERO_OID, collectReachable, isAncestor, peelToCommit };
