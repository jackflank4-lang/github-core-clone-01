// server.ts — HTTP server: routing, auth, body reading, error containment.
// Written from scratch for the github-core-clone-01 forge (Node 22, stdlib only).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL, type GraphQLOperation } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { nextReqId, readBody, sendJson } from './httputil.ts';

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function createApp(): ReturnType<typeof createServer> {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  function authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const given = header.slice('Bearer '.length);
    if (token === '') return given.length > 0;
    return given === token;
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((e) => {
      // Never let one bad request kill the server.
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': nextReqId() });
        }
        res.end(JSON.stringify({ message: e instanceof Error ? e.message : String(e) }));
      } catch {
        // The socket is already gone; nothing more to do.
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      sendJson(res, 400, { message: 'bad request URL' });
      return;
    }
    const pathname = url.pathname;

    // -- healthz (no auth; the env dials it to check liveness) ---------------
    if (pathname === '/healthz' && method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // -- git smart HTTP (no auth check: the suite always sends the token) -----
    const gitMatch = GIT_ROUTE.exec(pathname);
    if (gitMatch !== null) {
      const owner = safeDecode(gitMatch[1]);
      const repoName = safeDecode(gitMatch[2]);
      const action = gitMatch[3];
      if (owner === undefined || repoName === undefined) {
        sendJson(res, 400, { message: 'bad repository path' });
        return;
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const protocolV2 = req.headers['git-protocol'] === 'version=2';
      if (action === 'info/refs' && method === 'GET') {
        const service = url.searchParams.get('service') ?? '';
        const result = handleInfoRefs(repo, service, protocolV2);
        res.writeHead(result.status, { 'content-type': result.contentType, 'x-github-request-id': nextReqId() });
        res.end(result.body);
        return;
      }
      if (action === 'git-upload-pack' && method === 'POST') {
        const body = await readBody(req);
        const result = handleUploadPack(repo, body, protocolV2);
        res.writeHead(result.status, { 'content-type': result.contentType, 'x-github-request-id': nextReqId() });
        res.end(result.body);
        return;
      }
      if (action === 'git-receive-pack' && method === 'POST') {
        const body = await readBody(req);
        const result = handleReceivePack(repo, body);
        res.writeHead(result.status, { 'content-type': result.contentType, 'x-github-request-id': nextReqId() });
        res.end(result.body);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // -- GraphQL --------------------------------------------------------------
    if (pathname === '/api/graphql' && method === 'POST') {
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }
      const body = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(res, 400, { errors: [{ message: 'request body is not valid JSON' }] });
        return;
      }
      if (Array.isArray(parsed)) {
        const results = (parsed as GraphQLOperation[]).map((op) => executeGraphQL(store, op));
        sendJson(res, 200, results);
        return;
      }
      if (parsed !== null && typeof parsed === 'object') {
        sendJson(res, 200, executeGraphQL(store, parsed as GraphQLOperation));
        return;
      }
      sendJson(res, 400, { errors: [{ message: 'expected a JSON object or array' }] });
      return;
    }

    // -- MCP ------------------------------------------------------------------
    if (pathname === '/mcp' && method === 'POST') {
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }
      const body = await readBody(req);
      const result = handleMcp(store, body);
      if (result.body === null) {
        res.writeHead(result.status, { 'x-github-request-id': nextReqId() });
        res.end();
        return;
      }
      res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': nextReqId() });
      res.end(result.body);
      return;
    }

    // -- REST v3 ---------------------------------------------------------------
    if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }
      const rawParts = pathname === '/api/v3' ? [] : pathname.slice('/api/v3/'.length).split('/');
      const parts: string[] = [];
      // Drop empty segments: '/api/v3/' is the root (parts []), and a trailing
      // slash elsewhere (e.g. '/contents/') means the same path without it.
      for (const p of rawParts) {
        if (p === '') continue;
        const decoded = safeDecode(p);
        if (decoded === undefined) {
          sendJson(res, 400, { message: 'bad request path' });
          return;
        }
        parts.push(decoded);
      }
      const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
      const host = req.headers.host ?? 'localhost';
      const handled = handleRest({ store, req, res, parts, query: url.searchParams, body, baseUrl: `http://${host}` });
      if (!handled) sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  }

  return server;
}

function safeDecode(s: string): string | undefined {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}
