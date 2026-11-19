// main.ts — the forge's entry point: an HTTP server that binds its own ephemeral
// port, registers with the make.fun environment, answers /healthz, long-polls
// /done, and exits 0 when the run is over. Written fresh in this session.
// Stdlib only: node:http.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { Ctx, readBody, sendJson, sendNotFound } from './server.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const STARTED_AT = Date.now();

const forge = new Forge();

// ---------------------------------------------------------------------------
// Web UI (a minimal read-only HTML surface: repository list, files, commits,
// issues, pull requests). No check tests it; it is here for humans.
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#111} a{color:#0969da} table{border-collapse:collapse;width:100%} td,th{border:1px solid #ddd;padding:.4rem .6rem;text-align:left} code{background:#f6f8fa;padding:.1rem .3rem;border-radius:4px} h1{font-size:1.4rem}</style></head><body><h1>${escapeHtml(title)}</h1>${body}<p><a href="/">All repositories</a></p></body></html>`;
}

function sendHtml(res: ServerResponse, status: number, ctx: Ctx, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'X-GitHub-Request-Id': ctx.requestId });
  res.end(html);
}

function handleWeb(ctx: Ctx, res: ServerResponse): boolean {
  const parts = ctx.pathParts;
  if (parts.length === 0) {
    const repos = forge.reposOf('adaiversen');
    const rows = repos
      .map((repo) => `<tr><td><a href="/${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}">${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}</a></td><td>${escapeHtml(repo.description)}</td><td>${repo.private ? 'private' : 'public'}</td></tr>`)
      .join('');
    return sendHtml(res, 200, ctx, page('Repositories', repos.length === 0 ? '<p>No repositories yet.</p>' : `<table><tr><th>Repository</th><th>Description</th><th>Visibility</th></tr>${rows}</table>`)), true;
  }
  if (parts.length >= 2) {
    const repo = forge.getRepo(parts[0]!, parts[1]!);
    if (!repo) return false;
    const sub = parts.slice(2);
    if (sub.length === 0) {
      const branches = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.slice('refs/heads/'.length));
      const issues = repo.issues.map((issue) => `<tr><td>#${issue.number}</td><td><a href="/${repo.owner}/${repo.name}/issues/${issue.number}">${escapeHtml(issue.title)}</a></td><td>${issue.state}</td></tr>`).join('');
      const pulls = repo.pulls.map((pull) => `<tr><td>#${pull.number}</td><td><a href="/${repo.owner}/${repo.name}/pulls/${pull.number}">${escapeHtml(pull.title)}</a></td><td>${pull.state}${pull.merged ? ' (merged)' : ''}</td></tr>`).join('');
      const body = `<p>${escapeHtml(repo.description)}</p><p>Default branch: <code>${escapeHtml(repo.defaultBranch)}</code> &middot; Branches: ${branches.map(escapeHtml).join(', ') || 'none'}</p><h2>Issues</h2>${issues ? `<table><tr><th>#</th><th>Title</th><th>State</th></tr>${issues}</table>` : '<p>No issues.</p>'}<h2>Pull requests</h2>${pulls ? `<table><tr><th>#</th><th>Title</th><th>State</th></tr>${pulls}</table>` : '<p>No pull requests.</p>'}`;
      return sendHtml(res, 200, ctx, page(`${repo.owner}/${repo.name}`, body)), true;
    }
    if (sub.length === 2 && sub[0] === 'issues') {
      const issue = forge.getIssue(repo, Number.parseInt(sub[1]!, 10));
      if (!issue) return false;
      return sendHtml(res, 200, ctx, page(`#${issue.number} ${issue.title}`, `<p>State: ${issue.state}</p><p>${escapeHtml(issue.body)}</p>`)), true;
    }
    if (sub.length === 2 && sub[0] === 'pulls') {
      const pull = forge.getPull(repo, Number.parseInt(sub[1]!, 10));
      if (!pull) return false;
      return sendHtml(res, 200, ctx, page(`#${pull.number} ${pull.title}`, `<p>State: ${pull.state}${pull.merged ? ' (merged)' : ''}</p><p>${escapeHtml(pull.body)}</p><p>Head: <code>${escapeHtml(pull.head)}</code> &rarr; Base: <code>${escapeHtml(pull.base)}</code></p>`)), true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const body = await readBody(req);
  const ctx = new Ctx(req.method ?? 'GET', url, req.url ?? '/', req.headers, body);

  // GET /healthz — no token, always 200 while the server is up.
  if (ctx.method === 'GET' && ctx.pathParts.length === 1 && ctx.pathParts[0] === 'healthz') {
    sendJson(res, 200, ctx, { ok: true, uptime_ms: Date.now() - STARTED_AT });
    return;
  }

  if (handleGit(forge, ctx, res)) return;
  if (handleRest(forge, ctx, res)) return;
  if (handleGraphql(forge, ctx, res)) return;
  if (handleMcp(forge, ctx, res)) return;

  // The HTML web UI (read-only; never JSON).
  if (ctx.method === 'GET' && handleWeb(ctx, res)) return;

  sendNotFound(res, ctx);
}

// ---------------------------------------------------------------------------
// Lifecycle: bind an ephemeral port, register, answer /healthz, poll /done.
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  dispatch(req, res).catch((err: unknown) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ message: (err as Error).message || 'Internal error' }));
    } else {
      res.end();
    }
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, payload: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(SHOP_TOKEN ? { Authorization: `Bearer ${SHOP_TOKEN}` } : {}) },
    body: JSON.stringify(payload),
  });
  return { status: response.status, text: await response.text() };
}

async function getJson(url: string): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { ...(SHOP_TOKEN ? { Authorization: `Bearer ${SHOP_TOKEN}` } : {}) },
  });
  return { status: response.status, text: await response.text() };
}

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (!port) throw new Error('the server did not bind a port');

  if (ENV_URL) {
    // Register within 20 seconds of starting. The first register wins (200);
    // a later one answers 409, which is also fine.
    const deadline = Date.now() + 18_000;
    let registered = false;
    while (Date.now() < deadline && !registered) {
      try {
        const { status } = await postJson(`${ENV_URL}/register`, { port });
        if (status === 200 || status === 409) registered = true;
      } catch {
        // The environment may not be reachable yet; retry briefly.
      }
      if (!registered) await sleep(250);
    }
    if (!registered) {
      console.error('could not register with the environment; continuing anyway');
    }

    // Long-poll /done until the run is over, backing off 250 ms -> 2000 ms.
    let backoff = 250;
    for (;;) {
      try {
        const { status, text } = await getJson(`${ENV_URL}/done`);
        if (status === 200) {
          const parsed = JSON.parse(text) as { done?: boolean };
          if (parsed.done === true) break;
        }
      } catch {
        // A failed poll is not fatal; keep polling.
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 2000);
    }
  } else {
    // No environment: serve until killed.
    console.log(`forge listening on http://127.0.0.1:${port} (no MAKEFUN_ENV_URL; not registering)`);
    await new Promise<void>(() => undefined);
  }

  server.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
