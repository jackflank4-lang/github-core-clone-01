// mcp.ts — the MCP endpoint (POST /mcp), JSON-RPC 2.0 Streamable HTTP, plain-JSON answers.
//
// Two eras are served: the modern 2026-07-28 era (`server/discover` with a
// supportedVersions list) and the legacy ≤2025-11-25 handshake (`initialize` +
// `notifications/initialized`, optional Mcp-Session-Id). Every request declares its
// revision in `_meta` and the MCP-Protocol-Version header; each is answered inside
// the suite's 3s budget (every tool here is in-process and fast).
//
// Auth: no Authorization header (or a wrong token) is HTTP 401. A non-JSON body is
// HTTP 400 with JSON-RPC -32700. An unknown tool is -32602, never HTTP 500. A tool
// call missing a required argument answers isError:true. Tools act on the same
// store as REST: a repo/issue created over MCP reads back over /api/v3 as the same
// objects, ids unchanged.

import { issueJson, pullJson, repoJson } from './rest.ts';
import { isRecord, type Repo, type Store } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];
const SESSION_ID = 'forge-1';

// The tool list is a frozen constant: two tools/list calls serialize byte-identically.
const TOOLS = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    title: 'Create a repository',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The repository name.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    title: 'Get a repository',
    description: 'Read one repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'list_repos',
    title: 'List repositories',
    description: 'List the authenticated user’s repositories.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({}),
      required: Object.freeze([]),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    title: 'Create an issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    title: 'List issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({ type: 'string', description: 'open, closed, or all.', enum: ['open', 'closed', 'all'] }),
      }),
      required: Object.freeze(['owner', 'repo']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'close_issue',
    title: 'Close an issue',
    description: 'Close an issue by number.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        issue_number: Object.freeze({ type: 'integer', description: 'The issue number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'issue_number']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    title: 'Create a pull request',
    description: 'Open a pull request from one branch into another.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch name.' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    title: 'Merge a pull request',
    description: 'Squash-merge a pull request by number.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner login.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        pull_number: Object.freeze({ type: 'integer', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
      additionalProperties: false,
    }),
  }),
]);

export interface McpRequest {
  method: string;
  headers: Map<string, string>;
  body: Buffer;
}

export interface McpResponse {
  status: number;
  body: unknown;
  contentType: string;
  headers?: Record<string, string>;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, error: JsonRpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

/** Returns null when the path is not the MCP endpoint. */
export function handleMcp(store: Store, segments: string[], req: McpRequest): McpResponse | null {
  if (segments.length !== 1 || segments[0] !== 'mcp') return null;
  if (req.method === 'DELETE') return { status: 204, body: null, contentType: 'application/json' };
  if (req.method !== 'POST') return { status: 404, body: { message: 'Not Found' }, contentType: 'application/json' };
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (match === null || match[1] !== store.token) {
    return { status: 401, body: { message: 'Bad credentials' }, contentType: 'application/json' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: rpcError(null, { code: -32700, message: 'Parse error: the request body is not valid JSON' }),
      contentType: 'application/json',
    };
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    return {
      status: 400,
      body: rpcError(isRecord(parsed) ? parsed.id ?? null : null, { code: -32600, message: 'Invalid Request' }),
      contentType: 'application/json',
    };
  }
  const id = parsed.id ?? null;
  const method = parsed.method;
  const params = isRecord(parsed.params) ? parsed.params : {};
  // A notification (no id) is answered with 202 and no body.
  if (parsed.id === undefined) {
    if (method.startsWith('notifications/')) return { status: 202, body: null, contentType: 'application/json' };
    return { status: 400, body: rpcError(null, { code: -32600, message: 'Invalid Request' }), contentType: 'application/json' };
  }
  switch (method) {
    case 'server/discover': {
      return {
        status: 200,
        body: rpcResult(id, {
          serverInfo: serverInfo(),
          capabilities: { tools: {} },
          supportedVersions: SUPPORTED_VERSIONS,
          instructions: 'A GitHub-compatible git forge. Tools create and read repositories, issues and pull requests.',
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
        }),
        contentType: 'application/json',
      };
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: serverInfo(),
        }),
        contentType: 'application/json',
        headers: { 'Mcp-Session-Id': SESSION_ID },
      };
    }
    case 'ping': {
      return { status: 200, body: rpcResult(id, {}), contentType: 'application/json' };
    }
    case 'tools/list': {
      return { status: 200, body: rpcResult(id, { tools: TOOLS }), contentType: 'application/json' };
    }
    case 'tools/call': {
      return toolsCall(store, id, params);
    }
    default: {
      if (method.startsWith('notifications/')) return { status: 202, body: null, contentType: 'application/json' };
      return {
        status: 200,
        body: rpcError(id, { code: -32601, message: `Method not found: ${method}` }),
        contentType: 'application/json',
      };
    }
  }
}

function toolsCall(store: Store, id: unknown, params: Record<string, unknown>): McpResponse {
  const name = params.name;
  const args = isRecord(params.arguments) ? params.arguments : {};
  if (typeof name !== 'string') {
    return { status: 200, body: rpcError(id, { code: -32602, message: 'tools/call needs a tool name' }), contentType: 'application/json' };
  }
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) {
    return { status: 200, body: rpcError(id, { code: -32602, message: `Unknown tool: ${name}` }), contentType: 'application/json' };
  }
  const required = (tool.inputSchema.required ?? []) as string[];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return { status: 200, body: rpcResult(id, toolError(`Missing required argument: ${key}`)), contentType: 'application/json' };
    }
  }
  try {
    const value = runTool(store, name, args);
    return { status: 200, body: rpcResult(id, toolResult(value)), contentType: 'application/json' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 200, body: rpcResult(id, toolError(message)), contentType: 'application/json' };
  }
}

function resolveRepoArg(store: Store, args: Record<string, unknown>): Repo {
  const owner = args.owner;
  const repo = args.repo;
  if (typeof owner !== 'string' || typeof repo !== 'string') throw new Error('owner and repo are required');
  if (!store.isViewer(owner)) throw new Error('Not Found');
  const found = store.getRepo(owner, repo);
  if (found === undefined) throw new Error('Not Found');
  return found;
}

function runTool(store: Store, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'create_repo': {
      if (typeof args.name !== 'string' || args.name.length === 0) throw new Error('name is required');
      const repo = store.createRepo(args.name, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      if (repo === null) throw new Error('Repository creation failed: name already exists on this account');
      return repoJson(store, repo);
    }
    case 'get_repo': {
      return repoJson(store, resolveRepoArg(store, args));
    }
    case 'list_repos': {
      return { repositories: store.listViewerRepos().map((r) => repoJson(store, r)) };
    }
    case 'create_issue': {
      const repo = resolveRepoArg(store, args);
      if (typeof args.title !== 'string' || args.title.length === 0) throw new Error('title is required');
      const created = store.createIssue(repo, { title: args.title, body: typeof args.body === 'string' ? args.body : '' });
      if ('error' in created) throw new Error(created.error);
      return issueJson(store, repo, created);
    }
    case 'list_issues': {
      const repo = resolveRepoArg(store, args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
      return { issues: issues.map((i) => issueJson(store, repo, i)) };
    }
    case 'close_issue': {
      const repo = resolveRepoArg(store, args);
      const number = typeof args.issue_number === 'number' ? args.issue_number : Number(args.issue_number);
      const issue = repo.issues.find((i) => i.number === number);
      if (issue === undefined) throw new Error('Not Found');
      issue.state = 'closed';
      const now = store.tick();
      issue.updatedSeq = store.currentSeq();
      issue.updatedAt = store.iso(now);
      return issueJson(store, repo, issue);
    }
    case 'create_pull_request': {
      const repo = resolveRepoArg(store, args);
      const title = args.title;
      const head = args.head;
      const base = args.base;
      if (typeof title !== 'string' || typeof head !== 'string' || typeof base !== 'string') throw new Error('title, head and base are required');
      const created = store.createPull(repo, { title, body: typeof args.body === 'string' ? args.body : '', head, base });
      if ('error' in created) throw new Error(created.error);
      return pullJson(store, repo, created);
    }
    case 'merge_pull_request': {
      const repo = resolveRepoArg(store, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) throw new Error('Not Found');
      const result = store.mergePull(repo, pull);
      if (typeof result === 'object') throw new Error(result.error);
      return pullJson(store, repo, pull);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
