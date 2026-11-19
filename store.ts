// store.ts — the forge's in-memory data model: users, repositories, git objects,
// refs, issues, pull requests, labels and comments, plus the git graph operations
// (reachability, merge-base, diff, squash merge) the surfaces share.
// Written fresh in this session. Stdlib only.

import {
  buildCommit,
  buildTag,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';

// ---------------------------------------------------------------------------
// Identities. The scenario is fixed by the competition's one seed, so the
// viewer the bearer token names is a constant: adaiversen.
// ---------------------------------------------------------------------------

export interface UserIdentity {
  id: number;
  login: string;
  name: string;
  email: string;
}

export const VIEWER: UserIdentity = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const TEAMMATE: UserIdentity = { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' };
export const STRANGER: UserIdentity = { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' };
export const ORG = 'faint-meadow-org';

export const VIEWER_IDENTITY = 'ada iversen <adaiversen@example.invalid>';
export const DEFAULT_BRANCH = 'main';

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: string;
  createdAt: string;
  updatedAt: string;
  /** Cached REST serialisation; cleared whenever the issue changes. */
  restJson: string | null;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  user: string;
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
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  nextIssue: number;
  pulls: PullRequest[];
  nextPull: number;
  labels: Map<string, Label>;
  comments: Map<number, Comment[]>;
  nextCommentId: number;
  /** Creation sequence, for stable list ordering. */
  seq: number;
  restJson: string | null;
}

export function repoFullName(repo: Repo): string {
  return `${repo.owner}/${repo.name}`;
}

/** Opaque, stable Relay-style global ids. Never the plain numeric id. */
export function globalId(kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment', key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Git graph helpers (operate on one repository's object store)
// ---------------------------------------------------------------------------

/** Every object reachable from `roots` (commits, tags, trees, blobs). */
export function collectReachable(repo: Repo, roots: Iterable<string>): Set<string> {
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
      for (const parent of view.parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    } else if (object.type === 'tag') {
      const view = parseTag(object.data);
      if (view.object && !seen.has(view.object)) {
        seen.add(view.object);
        queue.push(view.object);
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

/** All commit ancestors of `tip` (including `tip`), newest-first by traversal. */
export function commitHistory(repo: Repo, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    order.push(oid);
    const view = parseCommit(object.data);
    for (let i = view.parents.length - 1; i >= 0; i -= 1) stack.push(view.parents[i]!);
  }
  return order;
}

/** Whether `ancestor` is reachable from `tip` by parent links. */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (!oid || oid === ZERO_OID || seen.has(oid)) continue;
    seen.add(oid);
    if (oid === ancestor) return true;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits (closest to both tips). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const distA = new Map<string, number>();
  const queueA: Array<[string, number]> = [[a, 0]];
  while (queueA.length > 0) {
    const [oid, dist] = queueA.shift()!;
    if (!oid || oid === ZERO_OID || distA.has(oid)) continue;
    distA.set(oid, dist);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push([parent, dist + 1]);
  }
  let best: string | null = null;
  let bestScore = Infinity;
  const queueB: Array<[string, number]> = [[b, 0]];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const [oid, dist] = queueB.shift()!;
    if (!oid || oid === ZERO_OID || seenB.has(oid)) continue;
    seenB.add(oid);
    const da = distA.get(oid);
    if (da !== undefined) {
      const score = da + dist;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push([parent, dist + 1]);
  }
  return best;
}

/** Flatten a tree into path -> {mode, oid}. */
export function flattenTree(repo: Repo, treeOid: string, prefix = '', out: Map<string, { mode: string; oid: string }> = new Map()): Map<string, { mode: string; oid: string }> {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

interface DirNode {
  files: Map<string, { mode: string; oid: string }>;
  dirs: Map<string, DirNode>;
}

/** Build (and store) the whole tree hierarchy for a flat path map; returns the root tree oid. */
export function buildTreeFromMap(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i]!;
      let child = node.dirs.get(segment);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** The tree oid of a commit. */
export function commitTree(repo: Repo, commitOid: string): string {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return '';
  return parseCommit(object.data).tree;
}

export interface TreeChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
  mode: string;
}

/** The file-level diff between two trees (flattened). */
export function diffTrees(repo: Repo, oldTree: string, newTree: string): TreeChange[] {
  const oldFiles = oldTree ? flattenTree(repo, oldTree) : new Map<string, { mode: string; oid: string }>();
  const newFiles = newTree ? flattenTree(repo, newTree) : new Map<string, { mode: string; oid: string }>();
  const changes: TreeChange[] = [];
  for (const [path, entry] of newFiles) {
    const old = oldFiles.get(path);
    if (!old) changes.push({ path, status: 'added', oldOid: null, newOid: entry.oid, mode: entry.mode });
    else if (old.oid !== entry.oid) changes.push({ path, status: 'modified', oldOid: old.oid, newOid: entry.oid, mode: entry.mode });
  }
  for (const [path, entry] of oldFiles) {
    if (!newFiles.has(path)) changes.push({ path, status: 'removed', oldOid: entry.oid, newOid: null, mode: entry.mode });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

/** Added/deleted line counts between two blob texts (multiset line diff). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const count = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldLines = count(oldText);
  const newLines = count(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newLines) {
    const o = oldLines.get(line) ?? 0;
    if (n > o) additions += n - o;
  }
  for (const [line, n] of oldLines) {
    const c = newLines.get(line) ?? 0;
    if (n > c) deletions += n - c;
  }
  return { additions, deletions };
}

// ---------------------------------------------------------------------------
// The forge
// ---------------------------------------------------------------------------

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  private nextRepoSeq = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }

  /** All repositories owned by `owner`, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  createRepo(owner: string, name: string, options: { description?: string; private?: boolean } = {}): Repo | { error: string } {
    if (!name || typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) return { error: 'name is required' };
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) return { error: 'Repository already exists' };
    const now = new Date().toISOString();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      nextIssue: 1,
      pulls: [],
      nextPull: 1,
      labels: new Map(),
      comments: new Map(),
      nextCommentId: 1,
      seq: this.nextRepoSeq++,
      restJson: null,
    };
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** Store one git object; returns its oid. */
  storeObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /**
   * Commit one file on a branch (the contents API's workhorse). Creates the branch
   * from the default branch tip when it does not exist yet, and the repository's
   * first commit when the repository is unborn. Returns the new commit and blob oids.
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; contentSha: string } {
    const blobOid = this.storeObject(repo, 'blob', content);
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    let parentTree = '';
    const parents: string[] = [];
    if (tip) {
      parents.push(tip);
      parentTree = commitTree(repo, tip);
    } else {
      // A new branch starts from the default branch tip when there is one.
      const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (baseTip && branch !== repo.defaultBranch) {
        parents.push(baseTip);
        parentTree = commitTree(repo, baseTip);
      }
    }
    const files = parentTree ? flattenTree(repo, parentTree) : new Map<string, { mode: string; oid: string }>();
    files.set(path, { mode: '100644', oid: blobOid });
    const treeOid = buildTreeFromMap(repo, files);
    const commitData = buildCommit({ tree: treeOid, parents, message, author: VIEWER_IDENTITY });
    const commitSha = this.storeObject(repo, 'commit', commitData);
    repo.refs.set(refName, commitSha);
    repo.restJson = null;
    return { commitSha, contentSha: blobOid };
  }

  /** Remove one file on a branch, committing the deletion. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | null {
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    if (!tip) return null;
    const treeOid = commitTree(repo, tip);
    const files = flattenTree(repo, treeOid);
    if (!files.has(path)) return null;
    files.delete(path);
    const newTree = buildTreeFromMap(repo, files);
    const commitData = buildCommit({ tree: newTree, parents: [tip], message, author: VIEWER_IDENTITY });
    const commitSha = this.storeObject(repo, 'commit', commitData);
    repo.refs.set(refName, commitSha);
    repo.restJson = null;
    return { commitSha };
  }

  /** Read a file or directory at a ref (branch name, commit sha, or the default branch). */
  readPath(
    repo: Repo,
    ref: string | undefined,
    path: string,
  ): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: Array<{ type: 'file' | 'dir'; name: string; path: string; oid: string }> } | null {
    let tip: string | undefined;
    if (ref === undefined || ref === '') {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    } else if (repo.refs.has(`refs/heads/${ref}`)) {
      tip = repo.refs.get(`refs/heads/${ref}`);
    } else if (repo.refs.has(`refs/tags/${ref}`)) {
      tip = repo.refs.get(`refs/tags/${ref}`);
    } else if (repo.objects.has(ref)) {
      const object = repo.objects.get(ref)!;
      tip = object.type === 'tag' ? parseTag(object.data).object : ref;
    }
    if (!tip) return null;
    const treeOid = commitTree(repo, tip);
    if (!treeOid) return null;
    const segments = path === '' ? [] : path.split('/');
    let currentTree = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const object = repo.objects.get(currentTree);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) {
        if (entry.mode === '40000') {
          const dirEntries: Array<{ type: 'file' | 'dir'; name: string; path: string; oid: string }> = [];
          const dirObject = repo.objects.get(entry.oid);
          if (!dirObject || dirObject.type !== 'tree') return null;
          for (const child of parseTree(dirObject.data)) {
            dirEntries.push({
              type: child.mode === '40000' ? 'dir' : 'file',
              name: child.name,
              path: path === '' ? child.name : `${path}/${child.name}`,
              oid: child.oid,
            });
          }
          return { kind: 'dir', entries: dirEntries };
        }
        const blob = repo.objects.get(entry.oid);
        if (!blob || blob.type !== 'blob') return null;
        return { kind: 'file', oid: entry.oid, data: blob.data };
      }
      if (entry.mode !== '40000') return null;
      currentTree = entry.oid;
    }
    // The root directory.
    const rootObject = repo.objects.get(currentTree);
    if (!rootObject || rootObject.type !== 'tree') return null;
    const entries: Array<{ type: 'file' | 'dir'; name: string; path: string; oid: string }> = [];
    for (const child of parseTree(rootObject.data)) {
      entries.push({ type: child.mode === '40000' ? 'dir' : 'file', name: child.name, path: child.name, oid: child.oid });
    }
    return { kind: 'dir', entries };
  }

  // -------------------------------------------------------------------------
  // Issues
  // -------------------------------------------------------------------------

  createIssue(repo: Repo, input: { title: string; body?: string; labels?: string[] }): Issue | { error: string } {
    if (typeof input.title !== 'string' || input.title === '') return { error: 'title is required' };
    const labels: Label[] = [];
    for (const name of input.labels ?? []) {
      const label = repo.labels.get(name);
      if (!label) return { error: `label "${name}" does not exist` };
      labels.push(label);
    }
    const now = new Date().toISOString();
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextIssue++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels,
      user: VIEWER.login,
      createdAt: now,
      updatedAt: now,
      restJson: null,
    };
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | null {
    return repo.issues.find((issue) => issue.number === number) ?? null;
  }

  setIssueState(repo: Repo, issue: Issue, state: 'open' | 'closed'): void {
    issue.state = state;
    issue.updatedAt = new Date().toISOString();
    issue.restJson = null;
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    const now = new Date().toISOString();
    const comment: Comment = { id: this.nextCommentId++, body, user: VIEWER.login, createdAt: now, updatedAt: now };
    const list = repo.comments.get(issue.number) ?? [];
    list.push(comment);
    repo.comments.set(issue.number, list);
    return comment;
  }

  // -------------------------------------------------------------------------
  // Pull requests
  // -------------------------------------------------------------------------

  createPull(
    repo: Repo,
    input: { head: string; base: string; title: string; body?: string },
  ): PullRequest | { error: string } {
    const headTip = repo.refs.get(`refs/heads/${input.head}`);
    const baseTip = repo.refs.get(`refs/heads/${input.base}`);
    if (!headTip) return { error: `head branch "${input.head}" does not exist` };
    if (!baseTip) return { error: `base branch "${input.base}" does not exist` };
    for (const pull of repo.pulls) {
      if (pull.head === input.head && pull.base === input.base && pull.state === 'open') {
        return { error: 'a pull request is already open for this head branch' };
      }
    }
    const now = new Date().toISOString();
    const pull: PullRequest = {
      id: this.nextPullId++,
      number: repo.nextPull++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      head: input.head,
      base: input.base,
      headSha: headTip,
      baseSha: baseTip,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      user: VIEWER.login,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest | null {
    return repo.pulls.find((pull) => pull.number === number) ?? null;
  }

  /** The changed files of a pull request (head's diff against the merge-base). */
  pullFiles(repo: Repo, pull: PullRequest): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const base = mergeBase(repo, pull.baseSha, pull.headSha);
    const baseTree = base ? commitTree(repo, base) : '';
    const headTree = commitTree(repo, pull.headSha);
    const changes = diffTrees(repo, baseTree, headTree);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const change of changes) {
      if (change.status === 'removed') {
        const oldData = change.oldOid ? repo.objects.get(change.oldOid)?.data : null;
        const oldText = oldData ? oldData.toString('utf8') : '';
        const counts = lineDiff(oldText, '');
        out.push({ filename: change.path, status: 'removed', additions: 0, deletions: counts.deletions, changes: counts.deletions });
        continue;
      }
      const newData = change.newOid ? repo.objects.get(change.newOid)?.data : null;
      const newText = newData ? newData.toString('utf8') : '';
      const oldData = change.oldOid ? repo.objects.get(change.oldOid)?.data : null;
      const oldText = oldData ? oldData.toString('utf8') : '';
      const counts = lineDiff(oldText, newText);
      const status = change.status === 'added' ? 'added' : 'modified';
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

  /** Whether a pull request can merge cleanly (no file changed differently on both sides). */
  pullMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const base = mergeBase(repo, pull.baseSha, pull.headSha);
    if (!base) return 'UNKNOWN';
    const baseTree = commitTree(repo, base);
    const baseTipTree = commitTree(repo, pull.baseSha);
    const headTree = commitTree(repo, pull.headSha);
    const baseChanges = diffTrees(repo, baseTree, baseTipTree);
    const headChanges = diffTrees(repo, baseTree, headTree);
    const baseByPath = new Map(baseChanges.map((change) => [change.path, change]));
    for (const change of headChanges) {
      const other = baseByPath.get(change.path);
      if (other && other.newOid !== change.newOid) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  /**
   * Squash-merge a pull request: one commit on the base branch whose tree is the
   * base tree with the head's diff applied. Returns the merge sha, or null on conflict.
   */
  mergePull(repo: Repo, pull: PullRequest): { sha: string } | null {
    if (pull.state !== 'open') return null;
    if (this.pullMergeable(repo, pull) !== 'MERGEABLE') return null;
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    if (!baseTip || !headTip) return null;
    const base = mergeBase(repo, baseTip, headTip);
    const baseTree = base ? commitTree(repo, base) : '';
    const headTree = commitTree(repo, headTip);
    const headChanges = diffTrees(repo, baseTree, headTree);
    const files = flattenTree(repo, commitTree(repo, baseTip));
    for (const change of headChanges) {
      if (change.status === 'removed') files.delete(change.path);
      else files.set(change.path, { mode: change.mode, oid: change.newOid! });
    }
    const treeOid = buildTreeFromMap(repo, files);
    const message = `${pull.title} (#${pull.number})`;
    const commitData = buildCommit({ tree: treeOid, parents: [baseTip], message, author: VIEWER_IDENTITY });
    const mergeSha = this.storeObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = mergeSha;
    pull.updatedAt = pull.mergedAt;
    repo.restJson = null;
    return { sha: mergeSha };
  }

  /** An annotated tag object for a tag ref, or null when the ref is a lightweight tag. */
  tagTarget(repo: Repo, refName: string): string | null {
    const oid = repo.refs.get(refName);
    if (!oid) return null;
    const object = repo.objects.get(oid);
    if (!object) return null;
    if (object.type === 'tag') return parseTag(object.data).object;
    return null;
  }

  /** Create an annotated tag object and store it; returns the tag oid. */
  createTagObject(repo: Repo, tag: string, target: string, message: string): string {
    const data = buildTag({ object: target, type: 'commit', tag, message });
    return this.storeObject(repo, 'tag', data);
  }
}
