// rest.ts — the GitHub REST v3 surface (/api/v3).
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id; errors are JSON
// {message: string}; unknown routes are 404 JSON (never HTML); a malformed JSON body is 400.
// Auth: Authorization: Bearer <MAKEFUN_SHOP_TOKEN>; no token (or a wrong one) is 401.
// A repo belongs to the login the token names: the same name under another owner is 404,
// never 403.

import { hashObject, isOid, parseCommit } from './gitobj.ts';
import { isRecord, sha1Hex, type Issue, type Pull, type Repo, type Store } from './store.ts';

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  headers: Map<string, string>;
  body: Buffer;
  /** The request's origin (http://host), for absolute pagination Link headers. */
  baseUrl: string;
}

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

let requestCounter = 0;

export function requestId(): string {
  requestCounter += 1;
  return `req_${Date.now().toString(36)}_${requestCounter.toString(16).padStart(4, '0')}`;
}

/** Parse the request body as JSON, or null when empty; throws ApiError(400) when malformed. */
function parseJsonBody(req: RestRequest): unknown {
  if (req.body.length === 0) return null;
  try {
    return JSON.parse(req.body.toString('utf8'));
  } catch {
    throw new ApiError(400, 'Problems parsing JSON');
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const notFound = (what: string): ApiError => new ApiError(404, `${what} not found`);
const badRequest = (message: string): ApiError => new ApiError(400, message);

// ---------------------------------------------------------------------------
// response shapes (GitHub-compatible fields; the suite tolerates extra fields)
// ---------------------------------------------------------------------------

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = { login: repo.owner, id: repo.id === 0 ? 1000 : store.identity.viewerId, type: 'User' };
  return {
    id: repo.id,
    node_id: Buffer.from(`R_${repo.id}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    license: null,
    topics: [],
    has_issues: true,
    has_pull_requests: true,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    watchers_count: 0,
    stargazers_count: 0,
    forks_count: 0,
    size: 0,
    language: null,
    visibility: repo.private ? 'private' : 'public',
  };
}

function labelJson(label: { name: string; color: string; description: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description ?? '', default: false };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`I_${repo.id}_${issue.number}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    user: { login: store.viewerLogin(), id: store.identity.viewerId, type: 'User' },
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    author_association: 'OWNER',
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: Buffer.from(`PR_${repo.id}_${pull.number}`, 'utf8').toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, repo: repoJson(store, repo) },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, repo: repoJson(store, repo) },
    merged: pull.merged,
    mergeable: pull.state === 'open' ? store.pullMergeable(repo, pull) : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    user: { login: store.viewerLogin(), id: store.identity.viewerId, type: 'User' },
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    author_association: 'OWNER',
    draft: false,
  };
}

function commitJson(store: Store, repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const authorName = commit.author.replace(/ <.*$/, '');
  const authorEmail = (commit.author.match(/<([^>]*)>/) ?? [])[1] ?? '';
  const epoch = Number((commit.author.match(/ (\d+) \+0000$/) ?? [])[1] ?? store.baseNowSec);
  const date = store.iso(epoch);
  return {
    sha,
    node_id: Buffer.from(`C_${sha}`, 'utf8').toString('base64'),
    commit: {
      // GitHub returns the message without its trailing newline.
      message: commit.message.replace(/\n+$/, ''),
      author: { name: authorName, email: authorEmail, date },
      committer: { name: authorName, email: authorEmail, date },
      tree: { sha: commit.tree },
      verification: { verified: false, reason: 'unsigned' },
    },
    author: { login: store.viewerLogin(), id: store.identity.viewerId, type: 'User' },
    committer: { login: store.viewerLogin(), id: store.identity.viewerId, type: 'User' },
    parents: commit.parents.map((p) => ({ sha: p })),
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
  };
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

/** A paginated list reply: the page plus a Link header when a next page exists. The Link
 *  URL is absolute: the suite's client checks it with new URL(), which rejects a relative one. */
function paginate<T>(items: readonly T[], query: URLSearchParams, path: string, baseUrl: string): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = new URLSearchParams(query);
    next.set('page', String(pageNum + 1));
    next.set('per_page', String(perPage));
    headers.Link = `<${baseUrl}${path}?${next.toString()}>; rel="next"`;
  }
  return { page, headers };
}

function authCheck(store: Store, req: RestRequest): void {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (match === null || match[1] !== store.token) {
    throw new ApiError(401, 'Bad credentials');
  }
}

/** Resolve a repo from the path, enforcing the owner-is-viewer rule (404, never 403). */
function resolveRepo(store: Store, owner: string, name: string): Repo {
  if (!store.isViewer(owner)) throw notFound('Not Found');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) throw notFound('Not Found');
  return repo;
}

/** The handler. Returns null when the path is not a REST route. */
export function handleRest(store: Store, req: RestRequest): RestResponse | null {
  if (req.segments.length === 0 || req.segments[0] !== 'api' || req.segments[1] !== 'v3') return null;
  const path = `/api/v3${req.segments.length > 2 ? `/${req.segments.slice(2).join('/')}` : ''}`;
  const seg = req.segments.slice(2);
  try {
    authCheck(store, req);
    return route(store, req, seg, path);
  } catch (error) {
    if (error instanceof ApiError) return { status: error.status, body: { message: error.message } };
    throw error;
  }
}

function route(store: Store, req: RestRequest, seg: string[], path: string): RestResponse {
  const method = req.method;
  // GET /api/v3 — root.
  if (seg.length === 0 && method === 'GET') {
    return { status: 200, body: {}, headers: { 'X-OAuth-Scopes': 'repo, user' } };
  }
  // GET /api/v3/meta.
  if (seg.length === 1 && seg[0] === 'meta' && method === 'GET') {
    return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: true } };
  }
  // GET /api/v3/user.
  if (seg.length === 1 && seg[0] === 'user' && method === 'GET') {
    return {
      status: 200,
      body: {
        login: store.viewerLogin(),
        id: store.identity.viewerId,
        node_id: Buffer.from(`U_${store.identity.viewerId}`, 'utf8').toString('base64'),
        name: store.identity.viewerName,
        email: store.identity.viewerEmail,
        type: 'User',
        avatar_url: '',
        html_url: `https://github.com/${store.viewerLogin()}`,
        site_admin: false,
      },
    };
  }
  // /api/v3/user/repos
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.listViewerRepos().map((r) => repoJson(store, r));
      const { page, headers } = paginate(repos, req.query, path, req.baseUrl);
      return { status: 200, body: page, headers };
    }
    if (method === 'POST') {
      const body = parseJsonBody(req);
      if (!isRecord(body)) throw badRequest('request body must be a JSON object');
      const name = body.name;
      if (typeof name !== 'string' || name.length === 0) throw badRequest('name is required');
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw badRequest('name is not valid');
      const repo = store.createRepo(name, {
        private: body.private === true,
        description: typeof body.description === 'string' ? body.description : '',
      });
      if (repo === null) {
        return { status: 422, body: { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] } };
      }
      return { status: 201, body: repoJson(store, repo) };
    }
    return { status: 404, body: { message: 'Not Found' } };
  }
  // /api/v3/repos/{owner}/{repo}...
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = seg[1]!;
    const name = seg[2]!;
    const repo = resolveRepo(store, owner, name);
    const rest = seg.slice(3);
    if (rest.length === 0) {
      if (method === 'GET') return { status: 200, body: repoJson(store, repo) };
      if (method === 'PATCH') {
        const body = parseJsonBody(req);
        if (!isRecord(body)) throw badRequest('request body must be a JSON object');
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) {
          repo.defaultBranch = body.default_branch;
        }
        return { status: 200, body: repoJson(store, repo) };
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo);
        return { status: 204, body: null };
      }
      return { status: 404, body: { message: 'Not Found' } };
    }
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = store.branches(repo).map((b) => ({ name: b.name, commit: { sha: b.sha }, protected: false }));
        return { status: 200, body: branches };
      }
      if (rest.length === 2 && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${rest[1]}`);
        if (sha === undefined) throw notFound('Branch not found');
        return { status: 200, body: { name: rest[1], commit: { sha }, protected: false } };
      }
      return { status: 404, body: { message: 'Not Found' } };
    }
    if (rest[0] === 'commits') {
      if (rest.length === 1 && method === 'GET') {
        const shaParam = req.query.get('sha') ?? repo.defaultBranch;
        const tip = store.resolveRef(repo, shaParam);
        if (tip === null) throw notFound('No commit found for SHA');
        const commits = store.commitsOn(repo, tip);
        const { page, headers } = paginate(commits, req.query, path, req.baseUrl);
        const out = page.map((sha) => commitJson(store, repo, sha)).filter((c) => c !== null);
        return { status: 200, body: out, headers };
      }
      if (rest.length === 2 && method === 'GET') {
        const commit = commitJson(store, repo, rest[1]!);
        if (commit === null) throw notFound('No commit found for SHA');
        return { status: 200, body: commit };
      }
      return { status: 404, body: { message: 'Not Found' } };
    }
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') {
        const body = parseJsonBody(req);
        if (!isRecord(body)) throw badRequest('request body must be a JSON object');
        const ref = body.ref;
        // GitHub's API takes the sha at the top level ({ref, sha}); accept object.sha too.
        const sha = typeof body.sha === 'string'
          ? body.sha
          : isRecord(body.object) && typeof body.object.sha === 'string'
            ? body.object.sha
            : null;
        if (typeof ref !== 'string' || !ref.startsWith('refs/') || sha === null || !isOid(sha)) {
          throw badRequest('ref and object.sha are required');
        }
        if (!repo.objects.has(sha)) throw new ApiError(422, 'Object does not exist');
        if (repo.refs.has(ref)) throw new ApiError(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        return { status: 201, body: { ref, node_id: sha1Hex(ref), url: path, object: { type: 'commit', sha } } };
      }
      if (rest.length >= 3 && method === 'GET') {
        const ref = `refs/${rest.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) throw notFound('Not Found');
        return { status: 200, body: { ref, node_id: sha1Hex(ref), url: path, object: { type: 'commit', sha } } };
      }
      return { status: 404, body: { message: 'Not Found' } };
    }
    if (rest[0] === 'contents') {
      return handleContents(store, repo, req, rest.slice(1), path);
    }
    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'POST') {
        const body = parseJsonBody(req);
        if (!isRecord(body)) throw badRequest('request body must be a JSON object');
        if (typeof body.name !== 'string' || body.name.length === 0) throw badRequest('name is required');
        const label = store.createLabel(repo, body.name, typeof body.color === 'string' ? body.color : 'ededed', typeof body.description === 'string' ? body.description : '');
        return { status: 201, body: labelJson(label) };
      }
      if (rest.length === 1 && method === 'GET') {
        return { status: 200, body: [...repo.labels.values()].map(labelJson) };
      }
      return { status: 404, body: { message: 'Not Found' } };
    }
    if (rest[0] === 'issues') {
      return handleIssues(store, repo, req, rest.slice(1), path);
    }
    if (rest[0] === 'pulls') {
      return handlePulls(store, repo, req, rest.slice(1), path);
    }
    return { status: 404, body: { message: 'Not Found' } };
  }
  return { status: 404, body: { message: 'Not Found' } };
}

function handleContents(store: Store, repo: Repo, req: RestRequest, rest: string[], path: string): RestResponse {
  const method = req.method;
  const filePath = rest.join('/');
  if (filePath.length === 0) return { status: 404, body: { message: 'Not Found' } };
  const ref = req.query.get('ref') ?? repo.defaultBranch;
  if (method === 'GET') {
    const tree = store.branchTree(repo, ref);
    if (tree === null) throw notFound('This repository is empty.');
    const found = store.readPath(repo, tree, filePath);
    if (found === null) throw notFound('Not Found');
    if (found.kind === 'dir') {
      return {
        status: 200,
        body: found.entries.map((e) => ({
          type: e.mode === '40000' ? 'dir' : 'file',
          name: e.name,
          path: e.path,
          sha: e.oid,
          size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
          url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${e.path}`,
          download_url: e.mode === '40000' ? null : `/api/v3/repos/${repo.owner}/${repo.name}/contents/${e.path}`,
          html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${ref}/${e.path}`,
          git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${e.oid}`,
        })),
      };
    }
    const blob = repo.objects.get(found.blobOid);
    if (blob === undefined) throw notFound('Not Found');
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: filePath.split('/').pop(),
        path: filePath,
        content: blob.data.toString('base64'),
        sha: found.blobOid,
        url: path,
        download_url: path,
        html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${ref}/${filePath}`,
        git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${found.blobOid}`,
      },
    };
  }
  if (method === 'PUT') {
    const body = parseJsonBody(req);
    if (!isRecord(body)) throw badRequest('request body must be a JSON object');
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const message = typeof body.message === 'string' ? body.message : `Update ${filePath}`;
    const contentB64 = typeof body.content === 'string' ? body.content : null;
    if (contentB64 === null) throw badRequest('content is required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      throw badRequest('content is not valid base64');
    }
    // A stale sha (the file changed since the caller read it) is a 409.
    if (typeof body.sha === 'string') {
      const tip = repo.refs.get(`refs/heads/${branch}`);
      const tree = tip === undefined ? null : store.branchTree(repo, branch);
      if (tree !== null) {
        const current = store.readPath(repo, tree, filePath);
        if (current === null || current.kind !== 'file' || current.blobOid !== body.sha) {
          return { status: 409, body: { message: 'Conflict: the file has changed since you read it' } };
        }
      } else {
        return { status: 409, body: { message: 'Conflict: the file does not exist' } };
      }
    }
    const { commitOid, blobOid, isUpdate } = store.writeFile(repo, { branch, path: filePath, content, message });
    return {
      status: isUpdate ? 200 : 201,
      body: {
        content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
        commit: { sha: commitOid, message, author: { name: store.identity.viewerName, email: store.identity.viewerEmail }, committer: { name: store.identity.viewerName, email: store.identity.viewerEmail } },
      },
    };
  }
  if (method === 'DELETE') {
    const body = parseJsonBody(req);
    if (!isRecord(body)) throw badRequest('request body must be a JSON object');
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const message = typeof body.message === 'string' ? body.message : `Delete ${filePath}`;
    if (typeof body.sha !== 'string') throw badRequest('sha is required');
    const tree = store.branchTree(repo, branch);
    if (tree === null) throw notFound('Not Found');
    const current = store.readPath(repo, tree, filePath);
    if (current === null || current.kind !== 'file' || current.blobOid !== body.sha) {
      return { status: 409, body: { message: 'Conflict: the file has changed since you read it' } };
    }
    const commitOid = store.deleteFile(repo, { branch, path: filePath, message });
    if (commitOid === null) throw notFound('Not Found');
    return {
      status: 200,
      body: { commit: { sha: commitOid, message, author: { name: store.identity.viewerName, email: store.identity.viewerEmail }, committer: { name: store.identity.viewerName, email: store.identity.viewerEmail } } },
    };
  }
  return { status: 404, body: { message: 'Not Found' } };
}

function handleIssues(store: Store, repo: Repo, req: RestRequest, rest: string[], path: string): RestResponse {
  const method = req.method;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let issues = [...repo.issues];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const { page, headers } = paginate(issues.map((i) => issueJson(store, repo, i)), req.query, path, req.baseUrl);
      return { status: 200, body: page, headers };
    }
    if (method === 'POST') {
      const body = parseJsonBody(req);
      if (!isRecord(body)) throw badRequest('request body must be a JSON object');
      if (typeof body.title !== 'string' || body.title.length === 0) throw badRequest('title is required');
      const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      const created = store.createIssue(repo, { title: body.title, body: typeof body.body === 'string' ? body.body : '', labels });
      if ('error' in created) return { status: 422, body: { message: created.error } };
      return { status: 201, body: issueJson(store, repo, created) };
    }
    return { status: 404, body: { message: 'Not Found' } };
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return { status: 404, body: { message: 'Not Found' } };
  const issue = repo.issues.find((i) => i.number === number);
  if (issue === undefined) throw notFound('Not Found');
  if (rest.length === 1) {
    if (method === 'GET') return { status: 200, body: issueJson(store, repo, issue) };
    if (method === 'PATCH') {
      const body = parseJsonBody(req);
      if (!isRecord(body)) throw badRequest('request body must be a JSON object');
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const labels: Array<{ name: string; color: string; description: string }> = [];
        for (const name of body.labels) {
          if (typeof name !== 'string') continue;
          const label = repo.labels.get(name);
          if (label === undefined) return { status: 422, body: { message: `label ${JSON.stringify(name)} does not exist` } };
          labels.push(label);
        }
        issue.labels = labels;
      }
      const now = store.tick();
      issue.updatedSeq = store.currentSeq();
      issue.updatedAt = store.iso(now);
      return { status: 200, body: issueJson(store, repo, issue) };
    }
    return { status: 404, body: { message: 'Not Found' } };
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') {
      const { page, headers } = paginate(
        issue.comments.map((c) => ({
          id: c.id,
          body: c.body,
          created_at: store.iso(c.createdSeq),
          updated_at: store.iso(c.createdSeq),
          user: { login: store.viewerLogin(), id: store.identity.viewerId, type: 'User' },
          html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${c.id}`,
        })),
        req.query,
        path,
        req.baseUrl,
      );
      return { status: 200, body: page, headers };
    }
    if (method === 'POST') {
      const body = parseJsonBody(req);
      if (!isRecord(body)) throw badRequest('request body must be a JSON object');
      if (typeof body.body !== 'string' || body.body.length === 0) throw badRequest('body is required');
      const comment = store.addComment(repo, issue, body.body);
      return {
        status: 201,
        body: {
          id: comment.id,
          body: comment.body,
          created_at: store.iso(comment.createdSeq),
          updated_at: store.iso(comment.createdSeq),
          user: { login: store.viewerLogin(), id: store.identity.viewerId, type: 'User' },
          html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
        },
      };
    }
    return { status: 404, body: { message: 'Not Found' } };
  }
  return { status: 404, body: { message: 'Not Found' } };
}

function handlePulls(store: Store, repo: Repo, req: RestRequest, rest: string[], path: string): RestResponse {
  const method = req.method;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let pulls = [...repo.pulls];
      if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, headers } = paginate(pulls.map((p) => pullJson(store, repo, p)), req.query, path, req.baseUrl);
      return { status: 200, body: page, headers };
    }
    if (method === 'POST') {
      const body = parseJsonBody(req);
      if (!isRecord(body)) throw badRequest('request body must be a JSON object');
      if (typeof body.title !== 'string' || body.title.length === 0) throw badRequest('title is required');
      if (typeof body.head !== 'string' || typeof body.base !== 'string') throw badRequest('head and base are required');
      const created = store.createPull(repo, { title: body.title, body: typeof body.body === 'string' ? body.body : '', head: body.head, base: body.base });
      if ('error' in created) return { status: 422, body: { message: created.error } };
      return { status: 201, body: pullJson(store, repo, created) };
    }
    return { status: 404, body: { message: 'Not Found' } };
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return { status: 404, body: { message: 'Not Found' } };
  const pull = repo.pulls.find((p) => p.number === number);
  if (pull === undefined) throw notFound('Not Found');
  if (rest.length === 1) {
    if (method === 'GET') return { status: 200, body: pullJson(store, repo, pull) };
    if (method === 'PATCH') {
      const body = parseJsonBody(req);
      if (!isRecord(body)) throw badRequest('request body must be a JSON object');
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'closed' && pull.state === 'open') {
        pull.state = 'closed';
        const now = store.tick();
        pull.updatedSeq = store.currentSeq();
        pull.updatedAt = store.iso(now);
      }
      return { status: 200, body: pullJson(store, repo, pull) };
    }
    return { status: 404, body: { message: 'Not Found' } };
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const files = store.pullFiles(repo, pull).map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      sha: hashObject('blob', Buffer.alloc(0)),
    }));
    return { status: 200, body: files };
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull.state !== 'open') return { status: 405, body: { message: 'Pull request is not open' } };
    const result = store.mergePull(repo, pull);
    if (typeof result === 'object') {
      // A conflict is a 405; any other merge failure is a 422.
      if (result.error === 'merge conflict') return { status: 405, body: { message: 'Merge conflict' } };
      return { status: 422, body: { message: result.error } };
    }
    return { status: 200, body: { sha: result, merged: true, message: `Pull request successfully merged` } };
  }
  return { status: 404, body: { message: 'Not Found' } };
}
