// rest.ts — GitHub REST API v3 (/api/v3). Written from scratch for the
// github-core-clone-01 forge (Node 22, stdlib only). All reads/writes go
// through the store; every reply is JSON with X-GitHub-Request-Id.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ISO_TIME, Repo, Store, VIEWER_ID, VIEWER_LOGIN, type Issue, type PullRequest } from './store.ts';
import { bool, num, parseJsonBody, sendEmpty, sendJson, sendJsonString, str } from './httputil.ts';

const BASE = 'https://github.example';

function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, type: 'User', avatar_url: '', html_url: `${BASE}/${login}` };
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: store.repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${BASE}/${repo.owner}/${repo.name}`,
    clone_url: `${BASE}/${repo.owner}/${repo.name}.git`,
    git_url: `git://${BASE.slice(8)}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.example:${repo.owner}/${repo.name}.git`,
    created_at: ISO_TIME,
    updated_at: ISO_TIME,
    pushed_at: ISO_TIME,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + issue.number,
    node_id: store.issueGlobalId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? '000000' })),
    user: userJson(VIEWER_LOGIN, VIEWER_ID),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: ISO_TIME,
    updated_at: ISO_TIME,
    closed_at: issue.state === 'closed' ? ISO_TIME : null,
    html_url: `${BASE}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** Cached serialized single-issue JSON (the read benchmark hits this path). */
function issueJsonString(store: Store, repo: Repo, issue: Issue): string {
  const hit = repo.issueJsonCache.get(issue.number);
  if (hit !== undefined) return hit;
  const s = JSON.stringify(issueJson(store, repo, issue));
  repo.issueJsonCache.set(issue.number, s);
  return s;
}

export function pullJson(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown> {
  const mergeable = pr.state === 'open' ? !repo.prIsConflicted(pr) : null;
  return {
    id: repo.id * 1000000 + pr.number,
    node_id: store.pullGlobalId(repo, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${VIEWER_LOGIN}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${VIEWER_LOGIN}:${pr.baseRef}` },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable,
    mergeable_state: mergeable === null ? 'unknown' : mergeable ? 'clean' : 'dirty',
    user: userJson(VIEWER_LOGIN, VIEWER_ID),
    assignee: null,
    draft: false,
    created_at: ISO_TIME,
    updated_at: ISO_TIME,
    closed_at: pr.state === 'closed' ? ISO_TIME : null,
    html_url: `${BASE}/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

interface RestCtx {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  parts: string[]; // decoded path segments after /api/v3
  query: URLSearchParams;
  body: Buffer;
  baseUrl: string; // same-origin base for Link headers
}

/** Paginate a list; returns the page slice and a Link header value (or ''). */
function paginate<T>(items: T[], query: URLSearchParams, baseUrl: string, path: string): { page: T[]; link: string } {
  const perPage = Math.max(1, Math.min(100, num(query.get('per_page'), 30)));
  const pageNum = Math.max(1, num(query.get('page'), 1));
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  let link = '';
  if (start + page.length < items.length) {
    const q = new URLSearchParams(query);
    q.set('page', String(pageNum + 1));
    q.set('per_page', String(perPage));
    link = `<${baseUrl}${path}?${q.toString()}>; rel="next"`;
  }
  return { page, link };
}

function commitListJson(repo: Repo, tip: string, perPage: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0 && out.length < perPage) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const c = repo.parseCommitCached(oid);
    if (!c) continue;
    out.push({
      sha: oid,
      commit: {
        message: c.message,
        author: { name: VIEWER_LOGIN, email: 'adaiversen@example.invalid', date: ISO_TIME },
        committer: { name: VIEWER_LOGIN, email: 'adaiversen@example.invalid', date: ISO_TIME },
      },
      parents: c.parents.map((p) => ({ sha: p })),
    });
    for (let i = c.parents.length - 1; i >= 0; i -= 1) stack.push(c.parents[i]);
  }
  return out;
}

export function handleRest(ctx: RestCtx): boolean {
  const { store, req, res, parts, query, body } = ctx;
  const method = req.method ?? 'GET';

  const notFound = (): void => sendJson(res, 404, { message: 'Not Found' });
  const badRequest = (message: string): void => sendJson(res, 400, { message });
  const unprocessable = (message: string): void => sendJson(res, 422, { message });

  let jsonBody: Record<string, unknown> | undefined;
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    if (body.length > 0) {
      try {
        jsonBody = parseJsonBody(body);
      } catch {
        badRequest('Problems parsing JSON');
        return true;
      }
    }
  }

  // -- root / meta / user ----------------------------------------------------
  if (parts.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo' });
      return true;
    }
    return false;
  }
  if (parts[0] === 'meta' && parts.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0' });
      return true;
    }
    return false;
  }
  if (parts[0] === 'user' && parts.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, { ...userJson(VIEWER_LOGIN, VIEWER_ID), name: 'ada iversen', email: 'adaiversen@example.invalid' });
      return true;
    }
    return false;
  }
  if (parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'POST') {
      const name = str(jsonBody?.name);
      if (name === '') {
        unprocessable('name is required');
        return true;
      }
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) {
        unprocessable('name already exists on this account');
        return true;
      }
      const repo = store.createRepo(VIEWER_LOGIN, name, bool(jsonBody?.private, false), str(jsonBody?.description, ''));
      sendJson(res, 201, repoJson(store, repo));
      return true;
    }
    if (method === 'GET') {
      const repos = store.listReposByOwner(VIEWER_LOGIN);
      const { page, link } = paginate(repos, query, ctx.baseUrl, '/api/v3/user/repos');
      sendJson(res, 200, page.map((r) => repoJson(store, r)), link === '' ? {} : { link });
      return true;
    }
    return false;
  }

  // -- /repos/{owner}/{repo}/... ---------------------------------------------
  if (parts[0] !== 'repos' || parts.length < 3) return false;
  const owner = parts[1];
  const repoName = parts[2];
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    notFound();
    return true;
  }
  const rest = parts.slice(3);

  // /repos/{o}/{r} itself
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(store, repo));
      return true;
    }
    if (method === 'PATCH') {
      if (jsonBody?.description !== undefined) repo.description = str(jsonBody.description);
      sendJson(res, 200, repoJson(store, repo));
      return true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      sendEmpty(res, 204);
      return true;
    }
    return false;
  }

  // branches
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const list = repo.sortedRefs().filter((r) => r.name.startsWith('refs/heads/')).map((r) => ({
        name: r.name.slice('refs/heads/'.length),
        commit: { sha: r.oid },
        protected: false,
      }));
      sendJson(res, 200, list);
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      const oid = repo.getRef(`refs/heads/${rest[1]}`);
      if (oid === undefined) {
        notFound();
        return true;
      }
      sendJson(res, 200, { name: rest[1], commit: { sha: oid }, protected: false });
      return true;
    }
    return false;
  }

  // git/refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = str(jsonBody?.ref);
      const sha = str(jsonBody?.sha);
      if (!ref.startsWith('refs/')) {
        unprocessable('ref must start with refs/');
        return true;
      }
      if (repo.getRef(ref) !== undefined) {
        unprocessable('reference already exists');
        return true;
      }
      if (repo.getObject(sha) === undefined) {
        unprocessable('invalid sha');
        return true;
      }
      repo.setRef(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref}` });
      return true;
    }
    if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
      const oid = repo.getRef(`refs/heads/${rest[3]}`);
      if (oid === undefined) {
        notFound();
        return true;
      }
      sendJson(res, 200, { ref: `refs/heads/${rest[3]}`, object: { sha: oid, type: 'commit' } });
      return true;
    }
    return false;
  }

  // commits
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const refName = query.get('sha');
    let tip: string | undefined;
    if (refName !== null) tip = repo.resolveRef(refName) ?? repo.getRef(`refs/heads/${refName}`);
    else tip = repo.headOid();
    if (tip === undefined) {
      sendJson(res, 200, []);
      return true;
    }
    const perPage = Math.max(1, Math.min(100, num(query.get('per_page'), 30)));
    sendJson(res, 200, commitListJson(repo, tip, perPage));
    return true;
  }

  // contents (path may contain slashes; take the remainder of the URL path)
  if (rest[0] === 'contents') {
    const contentPath = rest.slice(1).join('/');
    if (method === 'PUT') {
      const message = str(jsonBody?.message);
      const contentB64 = str(jsonBody?.content);
      const branch = str(jsonBody?.branch, repo.defaultBranch);
      const sha = jsonBody?.sha !== undefined ? str(jsonBody.sha) : undefined;
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, 'base64');
      } catch {
        badRequest('content is not valid base64');
        return true;
      }
      const branchTip = repo.getRef(`refs/heads/${branch}`);
      const existing = branchTip !== undefined ? repo.readFileAt(branchTip, contentPath) : undefined;
      if (sha !== undefined) {
        if (existing === undefined) {
          notFound();
          return true;
        }
        if (existing.oid !== sha) {
          sendJson(res, 409, { message: 'sha does not match' });
          return true;
        }
      } else if (existing !== undefined) {
        unprocessable('file already exists');
        return true;
      }
      const result = repo.putFile(branch, contentPath, content, message);
      sendJson(res, result.created ? 201 : 200, {
        content: {
          name: contentPath.split('/').pop(),
          path: contentPath,
          sha: result.blobSha,
          size: content.length,
          type: 'file',
          encoding: 'base64',
          url: `/api/v3/repos/${owner}/${repoName}/contents/${contentPath}`,
        },
        commit: { sha: result.commitSha, message },
      });
      return true;
    }
    if (method === 'GET') {
      const refName = query.get('ref');
      let tip: string | undefined;
      if (refName !== null) tip = repo.resolveRef(refName) ?? repo.getRef(`refs/heads/${refName}`);
      else tip = repo.headOid();
      if (tip === undefined) {
        notFound();
        return true;
      }
      if (contentPath === '') {
        const entries = repo.listDirAt(tip, '');
        sendJson(res, 200, (entries ?? []).map((e) => ({
          name: e.name,
          path: e.path,
          sha: e.oid,
          size: 0,
          type: e.type,
          url: `/api/v3/repos/${owner}/${repoName}/contents/${e.path}`,
        })));
        return true;
      }
      const file = repo.readFileAt(tip, contentPath);
      if (file !== undefined) {
        sendJson(res, 200, {
          name: contentPath.split('/').pop(),
          path: contentPath,
          sha: file.oid,
          size: file.data.length,
          type: 'file',
          encoding: 'base64',
          content: file.data.toString('base64'),
          url: `/api/v3/repos/${owner}/${repoName}/contents/${contentPath}`,
        });
        return true;
      }
      const dir = repo.listDirAt(tip, contentPath);
      if (dir !== undefined) {
        sendJson(res, 200, dir.map((e) => ({
          name: e.name,
          path: e.path,
          sha: e.oid,
          size: 0,
          type: e.type,
          url: `/api/v3/repos/${owner}/${repoName}/contents/${e.path}`,
        })));
        return true;
      }
      notFound();
      return true;
    }
    if (method === 'DELETE') {
      const message = str(jsonBody?.message);
      const branch = str(jsonBody?.branch, repo.defaultBranch);
      const result = repo.deleteFile(branch, contentPath, message);
      if (result === undefined) {
        notFound();
        return true;
      }
      sendJson(res, 200, { commit: { sha: result.commitSha, message } });
      return true;
    }
    return false;
  }

  // labels
  if (rest[0] === 'labels' && rest.length === 1 && method === 'POST') {
    const name = str(jsonBody?.name);
    const color = str(jsonBody?.color, '000000');
    if (name === '') {
      unprocessable('name is required');
      return true;
    }
    repo.labels.set(name, { name, color });
    sendJson(res, 201, { name, color, description: '', default: false, url: `/api/v3/repos/${owner}/${repoName}/labels/${encodeURIComponent(name)}` });
    return true;
  }

  // issues
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = str(jsonBody?.title);
        const bodyText = str(jsonBody?.body, '');
        const labelNames: string[] = Array.isArray(jsonBody?.labels) ? (jsonBody.labels as unknown[]).map((l) => str(l)) : [];
        for (const l of labelNames) {
          if (!repo.labels.has(l)) {
            unprocessable(`label "${l}" does not exist`);
            return true;
          }
        }
        if (title === '') {
          unprocessable('title is required');
          return true;
        }
        const issue = repo.createIssue(title, bodyText, labelNames);
        sendJson(res, 201, issueJson(store, repo, issue));
        return true;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const direction = query.get('direction') ?? 'desc';
        let list = repo.issues.filter((i) => state === 'all' || i.state === state);
        list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        const { page, link } = paginate(list, query, ctx.baseUrl, `/api/v3/repos/${owner}/${repoName}/issues`);
        sendJson(res, 200, page.map((i) => issueJson(store, repo, i)), link === '' ? {} : { link });
        return true;
      }
      return false;
    }
    const issueNum = parseInt(rest[1], 10);
    if (Number.isNaN(issueNum)) return false;
    const issue = repo.findIssue(issueNum);
    if (rest.length === 2) {
      if (issue === undefined) {
        notFound();
        return true;
      }
      if (method === 'GET') {
        sendJsonString(res, 200, issueJsonString(store, repo, issue));
        return true;
      }
      if (method === 'PATCH') {
        if (jsonBody?.state === 'open' || jsonBody?.state === 'closed') issue.state = jsonBody.state as 'open' | 'closed';
        if (jsonBody?.title !== undefined) issue.title = str(jsonBody.title);
        if (jsonBody?.body !== undefined) issue.body = str(jsonBody.body);
        repo.invalidateIssue(issue.number);
        sendJson(res, 200, issueJson(store, repo, issue));
        return true;
      }
      return false;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) {
        notFound();
        return true;
      }
      if (method === 'POST') {
        const bodyText = str(jsonBody?.body);
        const comment = { id: repo.commentCounter, body: bodyText };
        repo.commentCounter += 1;
        issue.comments.push(comment);
        repo.invalidateIssue(issue.number);
        sendJson(res, 201, {
          id: comment.id,
          node_id: store.commentGlobalId(repo, comment.id),
          body: comment.body,
          user: userJson(VIEWER_LOGIN, VIEWER_ID),
          created_at: ISO_TIME,
          updated_at: ISO_TIME,
          html_url: `${BASE}/${owner}/${repoName}/issues/${issue.number}#issuecomment-${comment.id}`,
        });
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((c) => ({
          id: c.id,
          node_id: store.commentGlobalId(repo, c.id),
          body: c.body,
          user: userJson(VIEWER_LOGIN, VIEWER_ID),
          created_at: ISO_TIME,
          updated_at: ISO_TIME,
        })));
        return true;
      }
      return false;
    }
    return false;
  }

  // pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const head = str(jsonBody?.head);
        const base = str(jsonBody?.base);
        const title = str(jsonBody?.title);
        const bodyText = str(jsonBody?.body, '');
        if (repo.getRef(`refs/heads/${head}`) === undefined) {
          unprocessable('head branch does not exist');
          return true;
        }
        if (repo.getRef(`refs/heads/${base}`) === undefined) {
          unprocessable('base branch does not exist');
          return true;
        }
        const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
        if (dup !== undefined) {
          unprocessable('a pull request already exists');
          return true;
        }
        const pr = repo.createPull(title, bodyText, head, base);
        sendJson(res, 201, pullJson(store, repo, pr));
        return true;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
        const { page, link } = paginate(list, query, ctx.baseUrl, `/api/v3/repos/${owner}/${repoName}/pulls`);
        sendJson(res, 200, page.map((p) => pullJson(store, repo, p)), link === '' ? {} : { link });
        return true;
      }
      return false;
    }
    const prNum = parseInt(rest[1], 10);
    if (Number.isNaN(prNum)) return false;
    const pr = repo.findPull(prNum);
    if (rest.length === 2) {
      if (pr === undefined) {
        notFound();
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, pullJson(store, repo, pr));
        return true;
      }
      return false;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (pr === undefined) {
        notFound();
        return true;
      }
      const baseTip = repo.getRef(`refs/heads/${pr.baseRef}`);
      const headTip = repo.getRef(`refs/heads/${pr.headRef}`);
      if (baseTip === undefined || headTip === undefined) {
        sendJson(res, 200, []);
        return true;
      }
      const baseTree = repo.treeOf(baseTip);
      const headTree = repo.treeOf(headTip);
      if (baseTree === undefined || headTree === undefined) {
        sendJson(res, 200, []);
        return true;
      }
      const diff = repo.diffTrees(baseTree, headTree);
      sendJson(res, 200, diff.map((d) => ({
        filename: d.path,
        status: d.status,
        additions: d.additions,
        deletions: d.deletions,
        changes: d.changes,
      })));
      return true;
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pr === undefined) {
        notFound();
        return true;
      }
      if (pr.state === 'closed') {
        sendJson(res, 405, { message: 'pull request is already closed' });
        return true;
      }
      const result = repo.mergePullRequest(pr);
      if ('conflict' in result) {
        sendJson(res, 405, { message: 'merge conflict' });
        return true;
      }
      sendJson(res, 200, { sha: result.commitSha, merged: true, message: `${pr.title} (#${pr.number})` });
      return true;
    }
    return false;
  }

  return false;
}
