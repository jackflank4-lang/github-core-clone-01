// store.ts — the in-memory forge store: repos, git objects, refs, issues, PRs.
// All state lives here; nothing touches disk. Written from scratch for the
// github-core-clone-01 forge (Node 22, stdlib only).

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  makeObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type TreeEntry,
} from './gitpack.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** Fixed scenario epoch (2025-01-01T00:00:00Z): all timestamps are deterministic. */
export const EPOCH_SEC = 1735689600;
export const ISO_TIME = '2025-01-01T00:00:00Z';
export const AUTHOR_LINE = 'ada iversen <adaiversen@example.invalid> 1735689600 +0000';

export function b64u(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
}

export interface PullRequest {
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
}

export class Repo {
  id: number;
  name: string;
  owner: string;
  isPrivate: boolean;
  description: string;
  defaultBranch = 'main';
  refs = new Map<string, string>();
  objects = new Map<string, GitObject>();
  issues: Issue[] = [];
  pulls: PullRequest[] = [];
  labels = new Map<string, { name: string; color: string }>();
  counter = 1; // shared issue/PR number counter
  commentCounter = 1;
  /** Serialized single-issue JSON cache (invalidated on issue mutation). */
  issueJsonCache = new Map<number, string>();
  private commitCache = new Map<string, ReturnType<typeof parseCommit>>();

  constructor(id: number, owner: string, name: string, isPrivate: boolean, description: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
  }

  // -- objects ---------------------------------------------------------------
  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(obj: GitObject): void {
    if (!this.objects.has(obj.oid)) this.objects.set(obj.oid, obj);
  }

  putRaw(type: GitObject['type'], data: Buffer): GitObject {
    const obj = makeObject(type, data);
    this.putObject(obj);
    return obj;
  }

  // -- refs ------------------------------------------------------------------
  getRef(name: string): string | undefined {
    return this.refs.get(name);
  }

  setRef(name: string, oid: string): void {
    this.refs.set(name, oid);
  }

  deleteRef(name: string): boolean {
    return this.refs.delete(name);
  }

  headOid(): string | undefined {
    return this.refs.get(`refs/heads/${this.defaultBranch}`);
  }

  /** Resolve 'HEAD' or a full ref name to an oid (undefined if unborn/missing). */
  resolveRef(name: string): string | undefined {
    if (name === 'HEAD') return this.headOid();
    return this.refs.get(name);
  }

  /** All refs sorted by name (HEAD excluded; callers add it first). */
  sortedRefs(): Array<{ name: string; oid: string }> {
    return [...this.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The oid a tag object points at, or the oid itself if it is not a tag. */
  peel(oid: string): { target: string; isTag: boolean } {
    const obj = this.objects.get(oid);
    if (obj && obj.type === 'tag') {
      return { target: parseTag(obj.data).object, isTag: true };
    }
    return { target: oid, isTag: false };
  }

  // -- commits ---------------------------------------------------------------
  parseCommitCached(oid: string): ReturnType<typeof parseCommit> | undefined {
    const hit = this.commitCache.get(oid);
    if (hit) return hit;
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'commit') return undefined;
    const parsed = parseCommit(obj.data);
    this.commitCache.set(oid, parsed);
    return parsed;
  }

  /** All commit oids reachable from `start` (following parents), including start. */
  ancestors(start: string): Set<string> {
    const out = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      out.add(oid);
      const c = this.parseCommitCached(oid);
      if (c) for (const p of c.parents) stack.push(p);
    }
    return out;
  }

  /** True if `a` is an ancestor of (or equal to) `b`. */
  isAncestor(a: string, b: string): boolean {
    if (a === b) return true;
    return this.ancestors(b).has(a);
  }

  /** Nearest common ancestor of a and b (BFS from b over parents). */
  mergeBase(a: string, b: string): string | undefined {
    const aAnc = this.ancestors(a);
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (aAnc.has(oid)) return oid;
      const c = this.parseCommitCached(oid);
      if (c) for (const p of c.parents) queue.push(p);
    }
    return undefined;
  }

  /** The root tree oid of a commit (undefined if the commit is missing). */
  treeOf(commitOid: string): string | undefined {
    return this.parseCommitCached(commitOid)?.tree;
  }

  // -- trees / files ---------------------------------------------------------
  /** Flat map path -> blob oid for the tree rooted at `treeOid`. */
  flatFiles(treeOid: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (oid: string, prefix: string): void => {
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'tree') return;
      for (const e of parseTree(obj.data)) {
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') walk(e.oid, path);
        else out.set(path, e.oid);
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Read a file's blob oid + bytes at a commit. */
  readFileAt(commitOid: string, path: string): { oid: string; data: Buffer } | undefined {
    const tree = this.treeOf(commitOid);
    if (tree === undefined) return undefined;
    const files = this.flatFiles(tree);
    const oid = files.get(path);
    if (oid === undefined) return undefined;
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'blob') return undefined;
    return { oid, data: obj.data };
  }

  /** List the immediate children of a directory at a commit (undefined if the path is not a dir). */
  listDirAt(commitOid: string, path: string): Array<{ name: string; path: string; oid: string; type: 'file' | 'dir' }> | undefined {
    const tree = this.treeOf(commitOid);
    if (tree === undefined) return undefined;
    let cur = tree;
    if (path !== '') {
      for (const part of path.split('/')) {
        const obj = this.objects.get(cur);
        if (!obj || obj.type !== 'tree') return undefined;
        const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
        if (!entry) return undefined;
        cur = entry.oid;
      }
    }
    const obj = this.objects.get(cur);
    if (!obj || obj.type !== 'tree') return undefined;
    return parseTree(obj.data).map((e) => ({
      name: e.name,
      path: path === '' ? e.name : `${path}/${e.name}`,
      oid: e.oid,
      type: e.mode === '40000' ? ('dir' as const) : ('file' as const),
    }));
  }

  /**
   * Build (and store) nested tree objects from a flat path -> blob oid map.
   * Returns the root tree oid.
   */
  buildTreesFromFiles(files: Map<string, string>): string {
    const dirs = new Map<string, Map<string, TreeEntry>>();
    const getDir = (dir: string): Map<string, TreeEntry> => {
      let d = dirs.get(dir);
      if (!d) {
        d = new Map();
        dirs.set(dir, d);
      }
      return d;
    };
    getDir('');
    for (const [path, blobOid] of files) {
      const parts = path.split('/');
      for (let i = 0; i < parts.length - 1; i += 1) {
        const dirPath = parts.slice(0, i + 1).join('/');
        const parent = getDir(parts.slice(0, i).join('/'));
        if (!parent.has(parts[i])) {
          parent.set(parts[i], { mode: '40000', name: parts[i], oid: '' });
        }
        getDir(dirPath);
      }
      const parent = getDir(parts.slice(0, -1).join('/'));
      parent.set(parts[parts.length - 1], { mode: '100644', name: parts[parts.length - 1], oid: blobOid });
    }
    // Build bottom-up: deepest dirs first. The root ('') has depth 0, so it is
    // always built last, after every directory it contains.
    const depth = (d: string): number => (d === '' ? 0 : d.split('/').length);
    const dirPaths = [...dirs.keys()].sort((a, b) => depth(b) - depth(a));
    const treeOids = new Map<string, string>();
    for (const dir of dirPaths) {
      const entries = [...dirs.get(dir)!.values()];
      for (const e of entries) {
        if (e.mode === '40000') e.oid = treeOids.get(dir === '' ? e.name : `${dir}/${e.name}`) as string;
      }
      const treeObj = this.putRaw('tree', buildTree(entries));
      treeOids.set(dir, treeObj.oid);
    }
    return treeOids.get('') as string;
  }

  /** Create and store a commit; returns its oid. */
  createCommit(message: string, treeOid: string, parents: string[]): string {
    const data = buildCommit(treeOid, parents, AUTHOR_LINE, AUTHOR_LINE, message);
    return this.putRaw('commit', data).oid;
  }

  // -- contents --------------------------------------------------------------
  /**
   * Write a file on a branch (creating the branch from the default tip if it
   * does not exist yet, or a root commit if the repo is unborn). Returns the
   * new commit oid, the blob oid, and whether the file was newly created.
   */
  putFile(branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string; created: boolean } {
    const refName = `refs/heads/${branch}`;
    let tip = this.refs.get(refName);
    if (tip === undefined) {
      if (branch === this.defaultBranch) tip = undefined;
      else tip = this.headOid();
    }
    const files = tip !== undefined ? this.flatFiles(this.treeOf(tip) as string) : new Map<string, string>();
    const created = !files.has(path);
    const blob = this.putRaw('blob', content);
    files.set(path, blob.oid);
    const treeOid = this.buildTreesFromFiles(files);
    const commitOid = this.createCommit(message, treeOid, tip !== undefined ? [tip] : []);
    this.refs.set(refName, commitOid);
    return { commitSha: commitOid, blobSha: blob.oid, created };
  }

  /** Delete a file on a branch; returns the new commit oid, or undefined if the file is absent. */
  deleteFile(branch: string, path: string, message: string): { commitSha: string } | undefined {
    const refName = `refs/heads/${branch}`;
    const tip = this.refs.get(refName);
    if (tip === undefined) return undefined;
    const files = this.flatFiles(this.treeOf(tip) as string);
    if (!files.has(path)) return undefined;
    files.delete(path);
    const treeOid = this.buildTreesFromFiles(files);
    const commitOid = this.createCommit(message, treeOid, [tip]);
    this.refs.set(refName, commitOid);
    return { commitSha: commitOid };
  }

  // -- closure (fetch) -------------------------------------------------------
  /**
   * Objects reachable from `starts` (commits), walking parents unless a depth
   * limit or a shallow boundary stops the walk. Returns the object set plus,
   * when depth-limited, the boundary commits (the deepest commits included).
   */
  collectClosure(
    starts: string[],
    opts: { depth?: number; shallowBoundaries?: Set<string> },
  ): { objects: Set<string>; boundary: string[] } {
    const objects = new Set<string>();
    const boundary: string[] = [];
    const queue: Array<{ oid: string; depth: number }> = starts.map((oid) => ({ oid, depth: 0 }));
    const seenCommits = new Set<string>();
    const addTree = (treeOid: string): void => {
      const stack = [treeOid];
      while (stack.length > 0) {
        const oid = stack.pop() as string;
        if (objects.has(oid)) continue;
        const obj = this.objects.get(oid);
        if (!obj || obj.type !== 'tree') continue;
        objects.add(oid);
        for (const e of parseTree(obj.data)) {
          if (e.mode === '40000') stack.push(e.oid);
          else objects.add(e.oid);
        }
      }
    };
    while (queue.length > 0) {
      const { oid, depth } = queue.shift() as { oid: string; depth: number };
      if (seenCommits.has(oid)) continue;
      seenCommits.add(oid);
      const c = this.parseCommitCached(oid);
      if (!c) continue;
      objects.add(oid);
      addTree(c.tree);
      const atDepthLimit = opts.depth !== undefined && depth >= opts.depth - 1;
      // A shallow boundary stops the walk only when no depth is requested:
      // the client holds the boundary commit but not its parents, so the
      // haves-closure (and a full fetch) must not walk past it. When a depth
      // IS requested the client is deepening past the boundary on purpose, so
      // the depth limit — not the boundary — governs the walk.
      const atShallow = opts.depth === undefined && opts.shallowBoundaries?.has(oid) === true;
      if (atDepthLimit) {
        boundary.push(oid);
        continue;
      }
      if (atShallow) continue;
      for (const p of c.parents) queue.push({ oid: p, depth: depth + 1 });
    }
    return { objects, boundary };
  }

  // -- diffs / merges --------------------------------------------------------
  countLines(data: Buffer): number {
    if (data.length === 0) return 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) n += 1;
    if (data[data.length - 1] !== 0x0a) n += 1;
    return n;
  }

  /** Diff two trees: [{path, status, additions, deletions, changes}]. */
  diffTrees(baseTree: string, headTree: string): Array<{ path: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }> {
    const base = this.flatFiles(baseTree);
    const head = this.flatFiles(headTree);
    const out: Array<{ path: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b === h) continue;
      const bData = b !== undefined ? this.objects.get(b)?.data : undefined;
      const hData = h !== undefined ? this.objects.get(h)?.data : undefined;
      if (b === undefined) {
        const additions = this.countLines(hData as Buffer);
        out.push({ path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (h === undefined) {
        const deletions = this.countLines(bData as Buffer);
        out.push({ path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else {
        const additions = this.countLines(hData as Buffer);
        const deletions = this.countLines(bData as Buffer);
        out.push({ path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /**
   * Three-way merge of base tip vs head tip with merge-base `base`.
   * Returns {conflict: boolean, files: Map<path, blobOid>} (files is the merged
   * tree content when there is no conflict).
   */
  threeWayMerge(baseTip: string, headTip: string, mergeBaseOid: string): { conflict: boolean; files: Map<string, string> } {
    const baseTree = this.treeOf(mergeBaseOid);
    const oursTree = this.treeOf(baseTip);
    const theirsTree = this.treeOf(headTip);
    const baseFiles = baseTree !== undefined ? this.flatFiles(baseTree) : new Map<string, string>();
    const oursFiles = oursTree !== undefined ? this.flatFiles(oursTree) : new Map<string, string>();
    const theirsFiles = theirsTree !== undefined ? this.flatFiles(theirsTree) : new Map<string, string>();
    const merged = new Map<string, string>(oursFiles);
    let conflict = false;
    const paths = new Set([...baseFiles.keys(), ...oursFiles.keys(), ...theirsFiles.keys()]);
    for (const path of paths) {
      const b = baseFiles.get(path);
      const o = oursFiles.get(path);
      const t = theirsFiles.get(path);
      if (o === t) continue;
      if (b === t) continue; // only ours changed
      if (b === o) {
        // only theirs changed: take theirs (or delete)
        if (t === undefined) merged.delete(path);
        else merged.set(path, t);
        continue;
      }
      conflict = true; // both changed differently
    }
    return { conflict, files: merged };
  }

  /** Is the PR conflicted? (Uses current branch tips, not creation snapshots.) */
  prIsConflicted(pr: PullRequest): boolean {
    const baseTip = this.refs.get(`refs/heads/${pr.baseRef}`);
    const headTip = this.refs.get(`refs/heads/${pr.headRef}`);
    if (baseTip === undefined || headTip === undefined) return false;
    const mb = this.mergeBase(baseTip, headTip);
    if (mb === undefined) return false;
    return this.threeWayMerge(baseTip, headTip, mb).conflict;
  }

  /**
   * Squash-merge a PR. Returns {commitSha} on success, or {conflict: true}
   * when the three-way merge conflicts. Updates the base branch and the PR.
   */
  mergePullRequest(pr: PullRequest): { commitSha: string } | { conflict: true } {
    const baseTip = this.refs.get(`refs/heads/${pr.baseRef}`);
    const headTip = this.refs.get(`refs/heads/${pr.headRef}`);
    if (baseTip === undefined || headTip === undefined) return { conflict: true };
    const mb = this.mergeBase(baseTip, headTip);
    if (mb === undefined) return { conflict: true };
    const { conflict, files } = this.threeWayMerge(baseTip, headTip, mb);
    if (conflict) return { conflict: true };
    const treeOid = this.buildTreesFromFiles(files);
    const message = `${pr.title} (#${pr.number})`;
    const commitOid = this.createCommit(message, treeOid, [baseTip]);
    this.refs.set(`refs/heads/${pr.baseRef}`, commitOid);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = ISO_TIME;
    pr.mergeCommitSha = commitOid;
    return { commitSha: commitOid };
  }

  // -- issues / PRs ----------------------------------------------------------
  findIssue(n: number): Issue | undefined {
    return this.issues.find((i) => i.number === n);
  }

  findPull(n: number): PullRequest | undefined {
    return this.pulls.find((p) => p.number === n);
  }

  createIssue(title: string, body: string, labels: string[]): Issue {
    const issue: Issue = { number: this.counter, title, body, state: 'open', labels: [...labels], comments: [] };
    this.counter += 1;
    this.issues.push(issue);
    return issue;
  }

  createPull(title: string, body: string, headRef: string, baseRef: string): PullRequest {
    const headSha = this.refs.get(`refs/heads/${headRef}`) ?? ZERO_OID;
    const baseSha = this.refs.get(`refs/heads/${baseRef}`) ?? ZERO_OID;
    const pr: PullRequest = {
      number: this.counter,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    };
    this.counter += 1;
    this.pulls.push(pr);
    return pr;
  }

  invalidateIssue(n: number): void {
    this.issueJsonCache.delete(n);
  }
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo = new Repo(this.nextRepoId, owner, name, isPrivate, description);
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.id - b.id);
  }

  /** Decode a global id into {kind, repoId, number}. */
  decodeGlobalId(id: string): { kind: string; repoId: number; number: number } | undefined {
    const m = /^(R|I|PR|IC)_(.+)$/.exec(id);
    if (!m) return undefined;
    try {
      const text = Buffer.from(m[2], 'base64url').toString('utf8');
      const parts = text.split(':');
      const kind = parts[0];
      const repoId = parseInt(parts[1], 10);
      const number = parts.length > 2 ? parseInt(parts[2], 10) : 0;
      if (Number.isNaN(repoId)) return undefined;
      return { kind, repoId, number };
    } catch {
      return undefined;
    }
  }

  repoById(id: number): Repo | undefined {
    return [...this.repos.values()].find((r) => r.id === id);
  }

  repoGlobalId(repo: Repo): string {
    return `R_${b64u(`Repository:${repo.id}`)}`;
  }

  issueGlobalId(repo: Repo, n: number): string {
    return `I_${b64u(`Issue:${repo.id}:${n}`)}`;
  }

  pullGlobalId(repo: Repo, n: number): string {
    return `PR_${b64u(`PullRequest:${repo.id}:${n}`)}`;
  }

  commentGlobalId(repo: Repo, id: number): string {
    return `IC_${b64u(`IssueComment:${repo.id}:${id}`)}`;
  }
}

/** The repo object id for a commit message used by the fixture's own commits. */
export function isZeroOid(oid: string): boolean {
  return oid === ZERO_OID;
}
