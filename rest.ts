// rest.ts — the REST v3 API: repositories, branches, commits, contents, labels,
// issues, comments and pull requests. Written fresh in this session from the
// GitHub REST shape and the competition checks. Stdlib only: node:http.

import type { ServerResponse } from 'node:http';
import {
  commitHistory,
  commitTree,
  diffTrees,
  flattenTree,
  globalId,
  lineDiff,
  type Forge,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import {
  absoluteUrl,
  Ctx,
  nowIso,
  paginate,
  parseJsonBody,
  rejectBadJson,
  sendError,
  sendJson,
  sendNotFound,
  userJson,
} from './server.ts';
import { blobSha } from './git.ts';
import { hashObject, isObjectId, parseCommit, parseTag } from './gitobj.ts';

const OAUTH_SCOPES = 'repo, read:org';

// ---------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------

export function repoJson(ctx: Ctx, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: { login: repo.owner, id: repo.owner === 'adaiversen' ? 1000 : 0, node_id: `U_${repo.owner === 'adaiversen' ? 1000 : 0}`, type: 'User' },
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}`),
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: null,
    size: repo.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

export function issueJson(ctx: Ctx, repo: Repo, issue: Issue): string {
  if (issue.restJson) return issue.restJson;
  const text = JSON.stringify({
    id: issue.id,
    node_id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`),
    repository_url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}`),
    labels_url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`),
    comments_url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`),
    events_url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`),
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: { login: issue.user, id: 1000, node_id: 'U_1000', type: 'User' },
    labels: issue.labels.map((label) => ({ id: 0, node_id: '', name: label.name, color: label.color, default: false, description: '' })),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: 0,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
    state_reason: null,
  });
  issue.restJson = text;
  return text;
}

export function pullJson(ctx: Ctx, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headUser = { login: repo.owner, id: 1000, node_id: 'U_1000', type: 'User' };
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
    url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}`),
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: { login: pull.user, id: 1000, node_id: 'U_1000', type: 'User' },
    body: pull.body,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/commits`),
    review_comments_url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/comments`),
    review_comment_url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/pulls/comments{/number}`),
    comments_url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}/comments`),
    statuses_url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/commits/${pull.headSha}/statuses`),
    head: {
      label: `${repo.owner}:${pull.head}`,
      ref: pull.head,
      sha: pull.headSha,
      user: headUser,
      repo: repoJson(ctx, repo),
    },
    base: {
      label: `${repo.owner}:${pull.base}`,
      ref: pull.base,
      sha: pull.baseSha,
      user: headUser,
      repo: repoJson(ctx, repo),
    },
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged: pull.merged,
    mergeable: pull.state === 'open',
    mergeable_state: pull.state === 'open' ? 'clean' : 'unknown',
    merged_by: pull.merged ? { login: pull.user, id: 1000, node_id: 'U_1000', type: 'User' } : null,
  };
}

function commentJson(ctx: Ctx, repo: Repo, issue: Issue, comment: { id: number; body: string; user: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}#${comment.id}`),
    url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`),
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`),
    user: { login: comment.user, id: 1000, node_id: 'U_1000', type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
    body: comment.body,
    reactions: { url: '', total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    performed_via_github_app: null,
  };
}

function branchJson(ctx: Ctx, repo: Repo, name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`) },
    protected: false,
  };
}

function commitJson(ctx: Ctx, repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const view = parseCommit(object.data);
  const authorLine = view.author || 'ada iversen <adaiversen@example.invalid>';
  const authorName = authorLine.replace(/ <.*$/, '');
  const authorEmail = (authorLine.match(/<([^>]*)>/) ?? [])[1] ?? '';
  const authorDate = new Date().toISOString();
  return {
    sha,
    node_id: `C_${sha.slice(0, 12)}`,
    commit: {
      author: { name: authorName, email: authorEmail, date: authorDate },
      committer: { name: authorName, email: authorEmail, date: authorDate },
      message: view.message,
      tree: { sha: view.tree, url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${view.tree}`) },
      url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`),
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`),
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}/comments`),
    author: { login: 'adaiversen', id: 1000, node_id: 'U_1000', type: 'User' },
    committer: { login: 'adaiversen', id: 1000, node_id: 'U_1000', type: 'User' },
    parents: view.parents.map((parent) => ({ sha: parent, url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}`), html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${parent}` })),
  };
}

function contentsFileJson(ctx: Ctx, repo: Repo, path: string, oid: string, data: Buffer): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: data.toString('base64'),
    sha: oid,
    url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`),
    git_url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${oid}`),
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/HEAD/${path}`,
    download_url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}?raw=1`),
    _links: {
      git: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${oid}`),
      self: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`),
      html: `https://github.com/${repo.owner}/${repo.name}/blob/HEAD/${path}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function isRestPath(pathParts: string[]): boolean {
  return pathParts.length >= 2 && pathParts[0] === 'api' && pathParts[1] === 'v3';
}

export function handleRest(forge: Forge, ctx: Ctx, res: ServerResponse): boolean {
  if (!isRestPath(ctx.pathParts)) return false;
  const extra: Record<string, string> = { 'X-OAuth-Scopes': OAUTH_SCOPES };
  try {
    if (!ctx.token) {
      sendJson(res, 401, ctx, { message: 'Requires authentication' }, extra);
      return true;
    }
    handleRestInner(forge, ctx, res, extra);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, ctx, { message: (err as Error).message || 'Internal error' }, extra);
    else res.end();
  }
  return true;
}

function handleRestInner(forge: Forge, ctx: Ctx, res: ServerResponse, extra: Record<string, string>): void {
  const parts = ctx.pathParts;

  // GET /api/v3/ — the root.
  if (parts.length === 2) {
    if (ctx.method !== 'GET') return sendNotFound(res, ctx);
    return sendJson(res, 200, ctx, {
      current_user_url: absoluteUrl(ctx, '/api/v3/user'),
      current_user_authorizations_html_url: 'https://github.com/settings/applications/authorizations',
      authorizations_url: absoluteUrl(ctx, '/api/v3/authorizations'),
      code_search_url: absoluteUrl(ctx, '/api/v3/search/code{?q}'),
      commit_search_url: absoluteUrl(ctx, '/api/v3/search/commits{?q}'),
      emails_url: absoluteUrl(ctx, '/api/v3/user/emails'),
      emojis_url: absoluteUrl(ctx, '/api/v3/emojis'),
      events_url: absoluteUrl(ctx, '/api/v3/events'),
      feeds_url: absoluteUrl(ctx, '/api/v3/feeds'),
      followers_url: absoluteUrl(ctx, '/api/v3/user/followers'),
      following_url: absoluteUrl(ctx, '/api/v3/user/following{/other_user}'),
      gists_url: absoluteUrl(ctx, '/api/v3/gists{/gist_id}'),
      hub_url: absoluteUrl(ctx, '/api/v3/hub'),
      issue_search_url: absoluteUrl(ctx, '/api/v3/search/issues{?q}'),
      issues_url: absoluteUrl(ctx, '/api/v3/issues'),
      keys_url: absoluteUrl(ctx, '/api/v3/user/keys'),
      label_search_url: absoluteUrl(ctx, '/api/v3/search/labels{?q}'),
      notifications_url: absoluteUrl(ctx, '/api/v3/notifications'),
      organization_url: absoluteUrl(ctx, '/api/v3/orgs/{org}'),
      organization_repositories_url: absoluteUrl(ctx, '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}'),
      organization_teams_url: absoluteUrl(ctx, '/api/v3/orgs/{org}/teams'),
      public_gists_url: absoluteUrl(ctx, '/api/v3/gists/public'),
      rate_limit_url: absoluteUrl(ctx, '/api/v3/rate_limit'),
      repository_url: absoluteUrl(ctx, '/api/v3/repos/{owner}/{repo}'),
      repository_search_url: absoluteUrl(ctx, '/api/v3/search/repositories{?q}'),
      current_user_repositories_url: absoluteUrl(ctx, '/api/v3/user/repos{?type,page,per_page,sort}'),
      starred_url: absoluteUrl(ctx, '/api/v3/user/starred{/owner}{/repo}'),
      starred_gists_url: absoluteUrl(ctx, '/api/v3/gists/starred'),
      topic_search_url: absoluteUrl(ctx, '/api/v3/search/topics{?q}'),
      user_url: absoluteUrl(ctx, '/api/v3/users/{user}'),
      user_organizations_url: absoluteUrl(ctx, '/api/v3/user/orgs'),
      user_repositories_url: absoluteUrl(ctx, '/api/v3/users/{user}/repos{?type,page,per_page,sort}'),
      user_search_url: absoluteUrl(ctx, '/api/v3/search/users{?q}'),
    }, extra);
  }

  // GET /api/v3/meta
  if (parts.length === 3 && parts[2] === 'meta') {
    if (ctx.method !== 'GET') return sendNotFound(res, ctx);
    return sendJson(res, 200, ctx, { verifiable_password_authentication: true, installed_version: '1.0.0', github_enterprise_version: '1.0.0' }, extra);
  }

  // GET /api/v3/user
  if (parts.length === 3 && parts[2] === 'user') {
    if (ctx.method !== 'GET') return sendNotFound(res, ctx);
    return sendJson(res, 200, ctx, userJson(), extra);
  }

  // /api/v3/user/repos
  if (parts.length === 4 && parts[2] === 'user' && parts[3] === 'repos') {
    if (ctx.method === 'GET') {
      const repos = forge.reposOf('adaiversen').map((repo) => repoJson(ctx, repo));
      const { page, links } = paginate(ctx, repos);
      const headers: Record<string, string> = { ...extra };
      if (links) headers.Link = links;
      return sendJson(res, 200, ctx, page, headers);
    }
    if (ctx.method === 'POST') {
      const body = parseJsonBody(ctx);
      if (rejectBadJson(res, ctx, body)) return;
      const input = (body ?? {}) as Record<string, unknown>;
      const name = typeof input.name === 'string' ? input.name : '';
      if (!name) return sendError(res, 422, ctx, 'name is required');
      const created = forge.createRepo('adaiversen', name, {
        description: typeof input.description === 'string' ? input.description : '',
        private: input.private === true,
      });
      if ('error' in created) return sendError(res, 422, ctx, created.error);
      return sendJson(res, 201, ctx, repoJson(ctx, created), extra);
    }
    return sendNotFound(res, ctx);
  }

  // /api/v3/repos/{owner}/{name}/...
  if (parts.length >= 5 && parts[2] === 'repos') {
    const owner = parts[3]!;
    const name = parts[4]!;
    const repo = forge.getRepo(owner, name);
    const tail = parts.slice(5);

    // The repository itself.
    if (tail.length === 0) {
      if (ctx.method === 'GET') {
        if (!repo) return sendNotFound(res, ctx);
        return sendJson(res, 200, ctx, repoJson(ctx, repo), extra);
      }
      if (ctx.method === 'PATCH') {
        if (!repo) return sendNotFound(res, ctx);
        const body = parseJsonBody(ctx);
        if (rejectBadJson(res, ctx, body)) return;
        const input = (body ?? {}) as Record<string, unknown>;
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.private = input.private;
        repo.updatedAt = nowIso();
        repo.restJson = null;
        return sendJson(res, 200, ctx, repoJson(ctx, repo), extra);
      }
      if (ctx.method === 'DELETE') {
        if (!repo) return sendNotFound(res, ctx);
        forge.deleteRepo(owner, name);
        res.writeHead(204, { 'X-GitHub-Request-Id': ctx.requestId, ...extra });
        res.end();
        return;
      }
      return sendNotFound(res, ctx);
    }

    if (!repo) return sendNotFound(res, ctx);

    // POST /git/refs
    if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && ctx.method === 'POST') {
      const body = parseJsonBody(ctx);
      if (rejectBadJson(res, ctx, body)) return;
      const input = (body ?? {}) as Record<string, unknown>;
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!ref.startsWith('refs/') || !isObjectId(sha) || !repo.objects.has(sha)) {
        return sendError(res, 422, ctx, 'Invalid ref or sha');
      }
      if (repo.refs.has(ref)) return sendError(res, 422, ctx, 'Reference already exists');
      repo.refs.set(ref, sha);
      repo.restJson = null;
      return sendJson(res, 201, ctx, {
        ref,
        node_id: `R_${sha.slice(0, 12)}`,
        url: absoluteUrl(ctx, `/api/v3/repos/${owner}/${name}/git/refs/${ref.replace(/^refs\//, '')}`),
        object: { sha, type: repo.objects.get(sha)!.type, url: absoluteUrl(ctx, `/api/v3/repos/${owner}/${name}/git/commits/${sha}`) },
      }, extra);
    }

    // GET /git/refs/heads/{branch}
    if (tail.length >= 4 && tail[0] === 'git' && tail[1] === 'refs' && tail[2] === 'heads' && ctx.method === 'GET') {
      const branch = tail.slice(3).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return sendNotFound(res, ctx);
      return sendJson(res, 200, ctx, {
        ref: `refs/heads/${branch}`,
        node_id: `R_${sha.slice(0, 12)}`,
        url: absoluteUrl(ctx, `/api/v3/repos/${owner}/${name}/git/refs/heads/${branch}`),
        object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: absoluteUrl(ctx, `/api/v3/repos/${owner}/${name}/git/commits/${sha}`) },
      }, extra);
    }

    // GET /branches
    if (tail.length === 1 && tail[0] === 'branches' && ctx.method === 'GET') {
      const branches: Record<string, unknown>[] = [];
      for (const refName of [...repo.refs.keys()].sort()) {
        if (!refName.startsWith('refs/heads/')) continue;
        branches.push(branchJson(ctx, repo, refName.slice('refs/heads/'.length), repo.refs.get(refName)!));
      }
      return sendJson(res, 200, ctx, branches, extra);
    }

    // GET /branches/{branch}
    if (tail.length >= 2 && tail[0] === 'branches' && ctx.method === 'GET') {
      const branch = tail.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) return sendNotFound(res, ctx);
      return sendJson(res, 200, ctx, branchJson(ctx, repo, branch, sha), extra);
    }

    // GET /commits
    if (tail.length === 1 && tail[0] === 'commits' && ctx.method === 'GET') {
      const ref = ctx.query.get('sha') ?? undefined;
      let tip: string | undefined;
      if (ref === undefined || ref === '') tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      else if (repo.refs.has(`refs/heads/${ref}`)) tip = repo.refs.get(`refs/heads/${ref}`);
      else if (repo.refs.has(`refs/tags/${ref}`)) tip = repo.refs.get(`refs/tags/${ref}`);
      else if (repo.objects.has(ref)) tip = ref;
      if (!tip) return sendJson(res, 200, ctx, [], extra);
      const history = commitHistory(repo, tip);
      const commits: Record<string, unknown>[] = [];
      for (const sha of history) {
        const entry = commitJson(ctx, repo, sha);
        if (entry) commits.push(entry);
      }
      const { page, links } = paginate(ctx, commits);
      const headers: Record<string, string> = { ...extra };
      if (links) headers.Link = links;
      return sendJson(res, 200, ctx, page, headers);
    }

    // /contents/{path...}
    if (tail[0] === 'contents') {
      const path = tail.slice(1).join('/');
      return handleContents(forge, repo, ctx, res, extra, path);
    }

    // POST /labels
    if (tail.length === 1 && tail[0] === 'labels' && ctx.method === 'POST') {
      const body = parseJsonBody(ctx);
      if (rejectBadJson(res, ctx, body)) return;
      const input = (body ?? {}) as Record<string, unknown>;
      const labelName = typeof input.name === 'string' ? input.name : '';
      const color = typeof input.color === 'string' ? input.color : 'ededed';
      if (!labelName) return sendError(res, 422, ctx, 'name is required');
      const existing = repo.labels.get(labelName);
      if (existing) {
        return sendJson(res, 201, ctx, { id: 0, node_id: '', name: existing.name, color: existing.color, default: false, description: '' }, extra);
      }
      const label = { name: labelName, color };
      repo.labels.set(labelName, label);
      return sendJson(res, 201, ctx, { id: 0, node_id: '', name: label.name, color: label.color, default: false, description: '' }, extra);
    }

    // /issues
    if (tail[0] === 'issues') {
      return handleIssues(forge, repo, ctx, res, extra, tail.slice(1));
    }

    // /pulls
    if (tail[0] === 'pulls') {
      return handlePulls(forge, repo, ctx, res, extra, tail.slice(1));
    }
  }

  return sendNotFound(res, ctx);
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

function handleContents(forge: Forge, repo: Repo, ctx: Ctx, res: ServerResponse, extra: Record<string, string>, path: string): void {
  if (ctx.method === 'GET') {
    const ref = ctx.query.get('ref') ?? undefined;
    const found = forge.readPath(repo, ref, path);
    if (!found) return sendNotFound(res, ctx);
    if (found.kind === 'file') {
      return sendJson(res, 200, ctx, contentsFileJson(ctx, repo, path, found.oid, found.data), extra);
    }
    const entries = found.entries.map((entry) => ({
      type: entry.type,
      size: entry.type === 'file' ? (repo.objects.get(entry.oid)?.data.length ?? 0) : 0,
      name: entry.name,
      path: entry.path,
      sha: entry.oid,
      url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/contents/${entry.path}`),
      git_url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/git/${entry.type === 'dir' ? 'trees' : 'blobs'}/${entry.oid}`),
      html_url: `https://github.com/${repo.owner}/${repo.name}/${entry.type === 'dir' ? 'tree' : 'blob'}/HEAD/${entry.path}`,
      download_url: entry.type === 'file' ? absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/contents/${entry.path}?raw=1`) : null,
      _links: {
        git: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/git/${entry.type === 'dir' ? 'trees' : 'blobs'}/${entry.oid}`),
        self: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/contents/${entry.path}`),
        html: `https://github.com/${repo.owner}/${repo.name}/${entry.type === 'dir' ? 'tree' : 'blob'}/HEAD/${entry.path}`,
      },
    }));
    return sendJson(res, 200, ctx, entries, extra);
  }

  if (ctx.method === 'PUT') {
    const body = parseJsonBody(ctx);
    if (rejectBadJson(res, ctx, body)) return;
    const input = (body ?? {}) as Record<string, unknown>;
    const message = typeof input.message === 'string' ? input.message : 'Update file';
    const contentB64 = typeof input.content === 'string' ? input.content : '';
    const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
    const givenSha = typeof input.sha === 'string' ? input.sha : undefined;
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
      if (contentB64 !== '' && content.toString('base64').replace(/=+$/, '') !== contentB64.replace(/=+$/, '')) {
        return sendError(res, 422, ctx, 'content is not valid base64');
      }
    } catch {
      return sendError(res, 422, ctx, 'content is not valid base64');
    }
    const existing = forge.readPath(repo, branch, path);
    if (givenSha !== undefined && existing && existing.kind === 'file' && existing.oid !== givenSha) {
      return sendError(res, 409, ctx, 'sha does not match the current file');
    }
    const isCreate = !existing || existing.kind !== 'file';
    const { commitSha, contentSha } = forge.commitFile(repo, branch, path, content, message);
    return sendJson(res, isCreate ? 201 : 200, ctx, {
      content: contentsFileJson(ctx, repo, path, contentSha, content),
      commit: { sha: commitSha, message, url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${commitSha}`) },
    }, extra);
  }

  if (ctx.method === 'DELETE') {
    const body = parseJsonBody(ctx);
    if (rejectBadJson(res, ctx, body)) return;
    const input = (body ?? {}) as Record<string, unknown>;
    const message = typeof input.message === 'string' ? input.message : 'Delete file';
    const givenSha = typeof input.sha === 'string' ? input.sha : undefined;
    const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
    const existing = forge.readPath(repo, branch, path);
    if (!existing || existing.kind !== 'file') return sendNotFound(res, ctx);
    if (givenSha !== undefined && existing.oid !== givenSha) {
      return sendError(res, 409, ctx, 'sha does not match the current file');
    }
    const deleted = forge.deleteFile(repo, branch, path, message);
    if (!deleted) return sendNotFound(res, ctx);
    return sendJson(res, 200, ctx, {
      commit: { sha: deleted.commitSha, message, url: absoluteUrl(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${deleted.commitSha}`) },
    }, extra);
  }

  return sendNotFound(res, ctx);
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

function handleIssues(forge: Forge, repo: Repo, ctx: Ctx, res: ServerResponse, extra: Record<string, string>, tail: string[]): void {
  if (tail.length === 0) {
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = ctx.query.get('direction') ?? 'desc';
      let issues = [...repo.issues];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const rendered = issues.map((issue) => JSON.parse(issueJson(ctx, repo, issue)) as Record<string, unknown>);
      const { page, links } = paginate(ctx, rendered);
      const headers: Record<string, string> = { ...extra };
      if (links) headers.Link = links;
      return sendJson(res, 200, ctx, page, headers);
    }
    if (ctx.method === 'POST') {
      const body = parseJsonBody(ctx);
      if (rejectBadJson(res, ctx, body)) return;
      const input = (body ?? {}) as Record<string, unknown>;
      const created = forge.createIssue(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        labels: Array.isArray(input.labels) ? input.labels.filter((label): label is string => typeof label === 'string') : [],
      });
      if ('error' in created) return sendError(res, 422, ctx, created.error);
      return sendJson(res, 201, ctx, issueJson(ctx, repo, created), extra);
    }
    return sendNotFound(res, ctx);
  }

  const number = Number.parseInt(tail[0]!, 10);
  if (!Number.isInteger(number)) return sendNotFound(res, ctx);
  const issue = forge.getIssue(repo, number);
  if (!issue) return sendNotFound(res, ctx);

  if (tail.length === 1) {
    if (ctx.method === 'GET') return sendJson(res, 200, ctx, issueJson(ctx, repo, issue), extra);
    if (ctx.method === 'PATCH') {
      const body = parseJsonBody(ctx);
      if (rejectBadJson(res, ctx, body)) return;
      const input = (body ?? {}) as Record<string, unknown>;
      if (typeof input.title === 'string') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      if (input.state === 'open' || input.state === 'closed') forge.setIssueState(repo, issue, input.state);
      else issue.restJson = null;
      issue.updatedAt = nowIso();
      issue.restJson = null;
      return sendJson(res, 200, ctx, issueJson(ctx, repo, issue), extra);
    }
    return sendNotFound(res, ctx);
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (ctx.method === 'GET') {
      const comments = (repo.comments.get(issue.number) ?? []).map((comment) => commentJson(ctx, repo, issue, comment));
      return sendJson(res, 200, ctx, comments, extra);
    }
    if (ctx.method === 'POST') {
      const body = parseJsonBody(ctx);
      if (rejectBadJson(res, ctx, body)) return;
      const input = (body ?? {}) as Record<string, unknown>;
      const commentBody = typeof input.body === 'string' ? input.body : '';
      if (!commentBody) return sendError(res, 422, ctx, 'body is required');
      const comment = forge.createComment(repo, issue, commentBody);
      return sendJson(res, 201, ctx, commentJson(ctx, repo, issue, comment), extra);
    }
    return sendNotFound(res, ctx);
  }

  return sendNotFound(res, ctx);
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

function handlePulls(forge: Forge, repo: Repo, ctx: Ctx, res: ServerResponse, extra: Record<string, string>, tail: string[]): void {
  if (tail.length === 0) {
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = [...repo.pulls];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      const rendered = pulls.map((pull) => pullJson(ctx, repo, pull));
      const { page, links } = paginate(ctx, rendered);
      const headers: Record<string, string> = { ...extra };
      if (links) headers.Link = links;
      return sendJson(res, 200, ctx, page, headers);
    }
    if (ctx.method === 'POST') {
      const body = parseJsonBody(ctx);
      if (rejectBadJson(res, ctx, body)) return;
      const input = (body ?? {}) as Record<string, unknown>;
      const created = forge.createPull(repo, {
        head: typeof input.head === 'string' ? input.head : '',
        base: typeof input.base === 'string' ? input.base : '',
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      if ('error' in created) return sendError(res, 422, ctx, created.error);
      return sendJson(res, 201, ctx, pullJson(ctx, repo, created), extra);
    }
    return sendNotFound(res, ctx);
  }

  const number = Number.parseInt(tail[0]!, 10);
  if (!Number.isInteger(number)) return sendNotFound(res, ctx);
  const pull = forge.getPull(repo, number);
  if (!pull) return sendNotFound(res, ctx);

  if (tail.length === 1) {
    if (ctx.method === 'GET') return sendJson(res, 200, ctx, pullJson(ctx, repo, pull), extra);
    return sendNotFound(res, ctx);
  }

  if (tail.length === 2 && tail[1] === 'files' && ctx.method === 'GET') {
    const files = forge.pullFiles(repo, pull);
    return sendJson(res, 200, ctx, files, extra);
  }

  if (tail.length === 2 && tail[1] === 'merge' && ctx.method === 'PUT') {
    const merged = forge.mergePull(repo, pull);
    if (!merged) {
      return sendError(res, 405, ctx, pull.state === 'closed' ? 'Pull request is already merged or closed' : 'Merge conflict');
    }
    return sendJson(res, 200, ctx, { merged: true, sha: merged.sha, message: 'Pull Request successfully merged' }, extra);
  }

  return sendNotFound(res, ctx);
}
