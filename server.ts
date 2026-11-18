// server.ts — the HTTP server: one Node http server, four surfaces, one store.
//
// Routing by path:
//   GET  /healthz                     the env's liveness probe (200 {"ok": true})
//   /api/v3/...                       REST v3 (rest.ts)
//   POST /api/graphql                 GraphQL (graphql.ts)
//   POST /mcp                         MCP, JSON-RPC 2.0 Streamable HTTP (mcp.ts)
//   /{owner}/{repo}.git/...           git smart HTTP (git.ts)
//   anything else                     404 JSON, never HTML
//
// A handler that throws is answered 500 JSON and the process keeps serving: a
// malformed request must never kill the forge mid-trial.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, requestId } from './rest.ts';
import { Store } from './store.ts';

const MAX_BODY_BYTES = 256 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

/** Send a pre-serialized JSON body (its byte length already known; no re-stringify). */
function sendText(res: ServerResponse, status: number, text: string, byteLength: number, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': byteLength,
    ...extraHeaders,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...extraHeaders });
  res.end(body);
}

/** Build the server for a store. The caller binds it (listen(0)) and registers the port. */
export function createForgeServer(store: Store): Server {
  return createServer((req, res) => {
    void (async () => {
      const rid = requestId();
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const rawSegments = url.pathname.split('/').filter((s) => s !== '');
        let segments: string[];
        try {
          // Most path segments carry no '%' at all; skip the decode call for those.
          segments = rawSegments.map((s) => (s.includes('%') ? decodeURIComponent(s) : s));
        } catch {
          sendJson(res, 400, { message: 'Bad Request' }, { 'x-github-request-id': rid });
          return;
        }
        const method = req.method ?? 'GET';
        // Handlers read the headers they need straight off req.headers (already
        // lower-cased by Node); building a Map per request was pure overhead.
        const headers = req.headers;
        const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
        // DELETE carries a body too (DELETE /contents sends {message, sha}).
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        const query = url.searchParams;

        // The env's liveness probe.
        if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
          sendJson(res, 200, { ok: true }, { 'x-github-request-id': rid });
          return;
        }

        // REST v3.
        if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
          const response = handleRest(store, { method, segments, query, headers, body, baseUrl: origin });
          if (response !== null) {
            const extra = { 'x-github-request-id': rid, ...(response.headers ?? {}) };
            if (response.status === 204) {
              res.writeHead(204, { 'content-length': 0, ...extra });
              res.end();
              return;
            }
            if (response.text !== undefined) {
              sendText(res, response.status, response.text, response.textLength ?? Buffer.byteLength(response.text), extra);
              return;
            }
            sendJson(res, response.status, response.body, extra);
            return;
          }
        }

        // GraphQL.
        if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          const response = handleGraphQL(store, segments, { method, headers, body });
          if (response !== null) {
            sendJson(res, response.status, response.body, { 'x-github-request-id': rid });
            return;
          }
        }

        // MCP.
        if (segments.length === 1 && segments[0] === 'mcp') {
          const response = handleMcp(store, segments, { method, headers, body });
          if (response !== null) {
            const extra = { ...(response.headers ?? {}) };
            if (response.status === 202 || response.status === 204 || response.body === null) {
              res.writeHead(response.status, { 'content-length': 0, ...extra });
              res.end();
              return;
            }
            sendJson(res, response.status, response.body, extra);
            return;
          }
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
          const response = handleGit(store, { method, segments, query, headers, body });
          if (response !== null) {
            sendBuffer(res, response.status, response.body, response.contentType);
            return;
          }
        }

        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': rid });
      } catch (error) {
        process.stderr.write(`[forge] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, { 'x-github-request-id': rid });
        else res.end();
      }
    })();
  });
}

/** Create the store from the environment and the server that serves it. */
export function createForge(): { store: Store; server: Server } {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '') process.stderr.write('[forge] MAKEFUN_SHOP_TOKEN is not set: every authenticated surface will answer 401\n');
  const store = new Store(token);
  return { store, server: createForgeServer(store) };
}
