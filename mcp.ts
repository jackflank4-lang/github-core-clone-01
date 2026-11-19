// mcp.ts — Model Context Protocol endpoint (POST /mcp, JSON-RPC 2.0).
// Modern era 2026-07-28, plain JSON responses. Written from scratch for the
// github-core-clone-01 forge (Node 22, stdlib only).

import { Repo, Store, VIEWER_LOGIN } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
const SERVER_INFO = { name: 'forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full name "owner/repo" (alternative to owner and repo).' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        full_name: { type: 'string', description: 'The full name "owner/repo" (alternative to owner and repo).' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
        full_name: { type: 'string', description: 'The full name "owner/repo" (alternative to owner and repo).' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
        full_name: { type: 'string', description: 'The full name "owner/repo" (alternative to owner and repo).' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
        full_name: { type: 'string', description: 'The full name "owner/repo" (alternative to owner and repo).' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

interface CallResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function textResult(obj: Record<string, unknown>): CallResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj };
}

function errorResult(message: string): CallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      owner = parts[0];
      repo = parts[1];
    }
  }
  return { owner, repo };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): CallResult {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (repoName === '') return errorResult('create_repo: "name" is required');
      if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) return errorResult(`create_repo: repository ${VIEWER_LOGIN}/${repoName} already exists`);
      const repo = store.createRepo(
        VIEWER_LOGIN,
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      return textResult(repoJson(store, repo));
    }
    case 'get_repo': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      if (owner === '' || repoName === '') return errorResult('get_repo: "owner" and "repo" are required');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult(`get_repo: repository ${owner}/${repoName} not found`);
      return textResult(repoJson(store, repo));
    }
    case 'create_issue': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      const title = typeof args.title === 'string' ? args.title : '';
      if (owner === '' || repoName === '') return errorResult('create_issue: "owner" and "repo" are required');
      if (title === '') return errorResult('create_issue: "title" is required');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult(`create_issue: repository ${owner}/${repoName} not found`);
      const issue = repo.createIssue(title, typeof args.body === 'string' ? args.body : '', []);
      return textResult(issueJson(store, repo, issue));
    }
    case 'list_issues': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      if (owner === '' || repoName === '') return errorResult('list_issues: "owner" and "repo" are required');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult(`list_issues: repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter((i) => state === 'all' || i.state === state);
      const arr = list.map((i) => issueJson(store, repo, i));
      return { content: [{ type: 'text', text: JSON.stringify(arr) }], structuredContent: { issues: arr } };
    }
    case 'create_pull_request': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (owner === '' || repoName === '') return errorResult('create_pull_request: "owner" and "repo" are required');
      if (title === '' || head === '' || base === '') return errorResult('create_pull_request: "title", "head" and "base" are required');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult(`create_pull_request: repository ${owner}/${repoName} not found`);
      if (repo.getRef(`refs/heads/${head}`) === undefined) return errorResult(`create_pull_request: head branch ${head} does not exist`);
      if (repo.getRef(`refs/heads/${base}`) === undefined) return errorResult(`create_pull_request: base branch ${base} does not exist`);
      const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (dup !== undefined) return errorResult('create_pull_request: a pull request already exists for this head and base');
      const pr = repo.createPull(title, typeof args.body === 'string' ? args.body : '', head, base);
      return textResult(pullJson(store, repo, pr));
    }
    case 'merge_pull_request': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number), 10);
      if (owner === '' || repoName === '') return errorResult('merge_pull_request: "owner" and "repo" are required');
      if (!Number.isFinite(pullNumber)) return errorResult('merge_pull_request: "pull_number" is required');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return errorResult(`merge_pull_request: repository ${owner}/${repoName} not found`);
      const pr = repo.findPull(pullNumber);
      if (pr === undefined) return errorResult(`merge_pull_request: pull request #${pullNumber} not found`);
      if (pr.state === 'closed') return errorResult(`merge_pull_request: pull request #${pullNumber} is already closed`);
      const result = repo.mergePullRequest(pr);
      if ('conflict' in result) return errorResult('merge_pull_request: merge conflict');
      return textResult({ number: pr.number, merged: true, sha: result.commitSha, state: 'closed', merge_commit_sha: result.commitSha });
    }
    default:
      return errorResult(`unknown tool ${name}`);
  }
}

export interface McpResponse {
  status: number;
  body: string | null; // null = empty body (202 for notifications)
}

/**
 * Handle one JSON-RPC request body (already read). Returns the HTTP status and
 * the response body (null for a notification, which gets 202 with no body).
 * Auth is enforced by the caller.
 */
export function handleMcp(store: Store, body: Buffer): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }),
    };
  }
  const req = parsed as { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id: answer 202 with no body.
  if (req.id === undefined) {
    return { status: 202, body: null };
  }

  const result = (value: unknown): McpResponse => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id, result: value }),
  });
  const error = (code: number, message: string): McpResponse => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
  });

  if (method === 'server/discover') {
    return result({
      supportedVersions: [MCP_PROTOCOL_VERSION],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { serverInfo: SERVER_INFO },
    });
  }
  if (method === 'initialize') {
    return result({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'tools/list') {
    return result({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!TOOLS.some((t) => t.name === toolName)) {
      return error(-32602, `unknown tool ${toolName}`);
    }
    const call = callTool(store, toolName, args);
    return result(call);
  }
  if (method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  return error(-32601, `method not found: ${method}`);
}
