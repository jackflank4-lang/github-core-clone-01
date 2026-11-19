// mcp.ts — the MCP endpoint (Streamable HTTP, plain JSON responses, legacy era
// 2025-11-25): initialize, notifications/initialized, tools/list and tools/call
// for the six forge tools. Written fresh in this session. Stdlib only: node:http.

import type { ServerResponse } from 'node:http';
import { type Forge, type Repo, VIEWER } from './store.ts';
import { Ctx, parseJsonBody, sendJson } from './server.ts';

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Tool definitions (a constant: byte-identical across calls)
// ---------------------------------------------------------------------------

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
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
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
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
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
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
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null | undefined, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: string | number | null | undefined, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolResult(payload: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
    structuredContent: payload,
    isError,
  };
}

/** The fields a tool requires, and whether the call supplied them all. */
function missingRequired(tool: ToolDefinition, args: Record<string, unknown>): string | null {
  const required = (tool.inputSchema.required ?? []) as string[];
  for (const field of required) {
    const value = args[field];
    if (value === undefined || value === null || value === '') return field;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool implementations (all backed by the forge's store)
// ---------------------------------------------------------------------------

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return toolResult({ error: `unknown tool "${name}"` }, true);
  const missing = missingRequired(tool, args);
  if (missing) return toolResult({ error: `missing required argument "${missing}"` }, true);

  switch (name) {
    case 'create_repo': {
      const created = forge.createRepo(VIEWER.login, String(args.name), {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      if ('error' in created) return toolResult({ error: created.error }, true);
      return toolResult({
        id: created.id,
        node_id: `R_${created.id}`,
        name: created.name,
        full_name: `${created.owner}/${created.name}`,
        private: created.private,
        owner: { login: created.owner, id: VIEWER.id },
        description: created.description,
        default_branch: created.defaultBranch,
        html_url: `https://github.com/${created.owner}/${created.name}`,
      });
    }
    case 'get_repo': {
      const repo = forge.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolResult({ error: `repository "${args.owner}/${args.repo}" not found` }, true);
      return toolResult({
        id: repo.id,
        node_id: `R_${repo.id}`,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        private: repo.private,
        owner: { login: repo.owner, id: VIEWER.id },
        description: repo.description,
        default_branch: repo.defaultBranch,
        html_url: `https://github.com/${repo.owner}/${repo.name}`,
      });
    }
    case 'create_issue': {
      const repo = forge.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolResult({ error: `repository "${args.owner}/${args.repo}" not found` }, true);
      const created = forge.createIssue(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
      });
      if ('error' in created) return toolResult({ error: created.error }, true);
      return toolResult({
        id: created.id,
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        user: { login: created.user, id: VIEWER.id },
        html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${created.number}`,
      });
    }
    case 'list_issues': {
      const repo = forge.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolResult({ error: `repository "${args.owner}/${args.repo}" not found` }, true);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => b.number - a.number);
      return toolResult(
        issues.map((issue) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          user: { login: issue.user, id: VIEWER.id },
          html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
        })),
      );
    }
    case 'create_pull_request': {
      const repo = forge.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolResult({ error: `repository "${args.owner}/${args.repo}" not found` }, true);
      const created = forge.createPull(repo, {
        head: String(args.head),
        base: String(args.base),
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
      });
      if ('error' in created) return toolResult({ error: created.error }, true);
      return toolResult({
        id: created.id,
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        head: { ref: created.head, sha: created.headSha },
        base: { ref: created.base, sha: created.baseSha },
        merged: created.merged,
        html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${created.number}`,
      });
    }
    case 'merge_pull_request': {
      const repo = forge.getRepo(String(args.owner), String(args.repo));
      if (!repo) return toolResult({ error: `repository "${args.owner}/${args.repo}" not found` }, true);
      const pull = forge.getPull(repo, Number(args.pull_number));
      if (!pull) return toolResult({ error: `pull request #${args.pull_number} not found` }, true);
      const merged = forge.mergePull(repo, pull);
      if (!merged) return toolResult({ error: 'Pull request cannot be merged' }, true);
      return toolResult({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        state: pull.state,
        merged: pull.merged,
        merged_at: pull.mergedAt,
        merge_commit_sha: pull.mergeCommitSha,
        html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
      });
    }
    default:
      return toolResult({ error: `unknown tool "${name}"` }, true);
  }
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export function isMcpPath(pathParts: string[]): boolean {
  return pathParts.length === 1 && pathParts[0] === 'mcp';
}

export function handleMcp(forge: Forge, ctx: Ctx, res: ServerResponse): boolean {
  if (!isMcpPath(ctx.pathParts)) return false;
  try {
    if (ctx.method === 'DELETE') {
      sendJson(res, 405, ctx, { message: 'Method Not Allowed' });
      return true;
    }
    if (ctx.method !== 'POST') {
      sendJson(res, 405, ctx, { message: 'Method Not Allowed' });
      return true;
    }
    if (!ctx.token) {
      sendJson(res, 401, ctx, { message: 'Requires authentication' });
      return true;
    }
    // A non-JSON body is a JSON-RPC parse error (-32700), still HTTP 200.
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(ctx.body.toString('utf8')) as JsonRpcRequest;
    } catch {
      sendJson(res, 200, ctx, rpcError(null, -32700, 'Parse error'));
      return true;
    }
    if (typeof request !== 'object' || request === null || typeof request.method !== 'string') {
      sendJson(res, 200, ctx, rpcError(null, -32600, 'Invalid Request'));
      return true;
    }
    const id = request.id ?? null;
    const params = (request.params ?? {}) as Record<string, unknown>;

    // The legacy era (2025-11-25) has no server/discover: answer -32601 so the
    // client falls back to the handshake.
    if (request.method === 'server/discover') {
      sendJson(res, 200, ctx, rpcError(id, -32601, 'Method not found'));
      return true;
    }

    if (request.method === 'initialize') {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const supported = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      if (offered !== '' && !supported.includes(offered)) {
        sendJson(res, 200, ctx, rpcError(id, -32602, `Unsupported protocol version "${offered}"`));
        return true;
      }
      sendJson(res, 200, ctx, rpcResult(id, {
        protocolVersion: offered !== '' ? offered : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }));
      return true;
    }

    if (request.method === 'notifications/initialized') {
      // A notification has no id: HTTP 202 with an empty body.
      res.writeHead(202, { 'X-GitHub-Request-Id': ctx.requestId });
      res.end();
      return true;
    }

    if (request.method === 'ping') {
      sendJson(res, 200, ctx, rpcResult(id, {}));
      return true;
    }

    if (request.method === 'tools/list') {
      sendJson(res, 200, ctx, rpcResult(id, { tools: TOOLS }));
      return true;
    }

    if (request.method === 'tools/call') {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (!TOOL_NAMES.has(toolName)) {
        sendJson(res, 200, ctx, rpcError(id, -32602, `Unknown tool "${toolName}"`));
        return true;
      }
      sendJson(res, 200, ctx, rpcResult(id, callTool(forge, toolName, args)));
      return true;
    }

    if (request.method.startsWith('notifications/')) {
      res.writeHead(202, { 'X-GitHub-Request-Id': ctx.requestId });
      res.end();
      return true;
    }

    // Unknown method.
    sendJson(res, 200, ctx, rpcError(id, -32601, 'Method not found'));
    return true;
  } catch (err) {
    if (!res.headersSent) sendJson(res, 200, ctx, rpcError(null, -32603, (err as Error).message || 'Internal error'));
    else res.end();
    return true;
  }
}
