// server.ts — the HTTP plumbing the forge's surfaces share: a request context,
// JSON replies, the bearer-token check, and the X-GitHub-Request-Id counter.
// Written fresh in this session. Stdlib only: node:http.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER } from './store.ts';

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

export class Ctx {
  readonly method: string;
  readonly url: URL;
  readonly rawUrl: string;
  readonly query: URLSearchParams;
  readonly pathParts: string[];
  readonly headers: IncomingMessage['headers'];
  readonly body: Buffer;
  /** The bearer token the caller sent, if any. */
  readonly token: string | null;
  readonly requestId: string;

  constructor(method: string, url: URL, rawUrl: string, headers: IncomingMessage['headers'], body: Buffer) {
    this.method = method;
    this.url = url;
    this.rawUrl = rawUrl;
    this.query = url.searchParams;
    this.pathParts = url.pathname.split('/').filter((part) => part !== '');
    this.headers = headers;
    this.body = body;
    this.requestId = nextRequestId();
    const auth = headers.authorization;
    this.token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
  }

  get header(): Record<string, string | string[] | undefined> {
    return this.headers;
  }
}

/** Every request carries a non-empty X-GitHub-Request-Id, on every surface. */
export function writeHead(res: ServerResponse, status: number, ctx: Ctx, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': ctx.requestId,
    ...extra,
  });
}

export function sendJson(res: ServerResponse, status: number, ctx: Ctx, payload: unknown, extra: Record<string, string> = {}): void {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  writeHead(res, status, ctx, extra);
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, ctx: Ctx, message: string): void {
  sendJson(res, status, ctx, { message });
}

export function sendNotFound(res: ServerResponse, ctx: Ctx): void {
  sendError(res, 404, ctx, 'Not Found');
}

/** The forge accepts any non-empty bearer token; the token names the viewer. */
export function requireAuth(ctx: Ctx): boolean {
  return ctx.token !== null && ctx.token !== '';
}

export function sendUnauthorized(res: ServerResponse, ctx: Ctx): void {
  sendError(res, 401, ctx, 'Requires authentication');
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Parse a JSON body; on malformed JSON returns null and the caller answers 400. */
export function parseJsonBody(ctx: Ctx): unknown | null {
  if (ctx.body.length === 0) return {};
  try {
    return JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return null;
  }
}

/** A 400 for a malformed JSON body. Returns true when the body was malformed. */
export function rejectBadJson(res: ServerResponse, ctx: Ctx, parsed: unknown): boolean {
  if (parsed === null) {
    sendError(res, 400, ctx, 'Problems parsing JSON');
    return true;
  }
  return false;
}

export function absoluteUrl(ctx: Ctx, path: string): string {
  const protocol = 'http';
  const host = typeof ctx.headers.host === 'string' ? ctx.headers.host : 'localhost';
  return `${protocol}://${host}${path}`;
}

/**
 * Render a page of items with GitHub-style Link headers and ?page= / ?per_page=
 * pagination. The caller supplies the full list; page size is clamped to 1..100.
 */
export function paginate<T>(ctx: Ctx, items: readonly T[]): { page: T[]; links: string } {
  const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(ctx.query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const basePath = ctx.url.pathname;
  const linkFor = (targetPage: number, rel: string): string => {
    const params = new URLSearchParams(ctx.query);
    params.set('page', String(targetPage));
    params.set('per_page', String(perPage));
    return `<${absoluteUrl(ctx, `${basePath}?${params.toString()}`)}>; rel="${rel}"`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(linkFor(page + 1, 'next'));
  if (page > 1) {
    links.push(linkFor(1, 'first'));
    links.push(linkFor(page - 1, 'prev'));
  }
  if (totalPages > 1) links.push(linkFor(totalPages, 'last'));
  return { page: slice, links: links.join(', ') };
}

/** An ISO timestamp. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** The viewer as a GitHub user object. */
export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: `U_${VIEWER.id}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER.id}?v=4`,
    gravatar_id: '',
    url: `https://api.github.com/users/${VIEWER.login}`,
    html_url: `https://github.com/${VIEWER.login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
    created_at: '2020-01-01T00:00:00Z',
    updated_at: '2020-01-01T00:00:00Z',
  };
}
