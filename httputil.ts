// httputil.ts — shared HTTP helpers for the forge's API handlers.
// Written from scratch for the github-core-clone-01 forge (Node 22, stdlib only).

import type { IncomingMessage, ServerResponse } from 'node:http';

let reqCounter = 0;

export function nextReqId(): string {
  reqCounter += 1;
  return `req-${reqCounter}`;
}

/** Read the whole request body as a Buffer (caps at 64 MB). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
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

export function sendJson(res: ServerResponse, status: number, obj: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(obj);
  sendJsonString(res, status, body, extraHeaders);
}

export function sendJsonString(res: ServerResponse, status: number, json: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextReqId(),
    ...extraHeaders,
  });
  res.end(json);
}

export function sendEmpty(res: ServerResponse, status: number, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { 'x-github-request-id': nextReqId(), ...extraHeaders });
  res.end();
}

export function sendText(res: ServerResponse, status: number, text: string, contentType = 'text/plain'): void {
  res.writeHead(status, { 'content-type': contentType, 'x-github-request-id': nextReqId() });
  res.end(text);
}

/** Parse a JSON body; returns undefined on empty body, throws on malformed JSON. */
export function parseJsonBody(body: Buffer): Record<string, unknown> | undefined {
  if (body.length === 0) return undefined;
  const parsed: unknown = JSON.parse(body.toString('utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('expected a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

export function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}
