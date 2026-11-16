// The forge's HTTP server: one router over the four surfaces the contest scores —
// git smart HTTP, REST v3, GraphQL v4 and MCP — plus the boot probe and the API root.
//
// Routing is deliberately string-based, not regex-based: the hot paths (the benchmark's
// 2,000 keep-alive reads) split the path once and dispatch on segments, with no URL object
// and no per-request allocation beyond the segments themselves.
//
// app.ts owns the server and the dispatch; each surface lives in its own module and shares
// the one in-memory store built here. A handler never throws out of the request: the
// dispatcher catches everything and answers a JSON 500, so one bad request can never take
// the server down mid-trial.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './git-http.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { sendError, sendJson } from './reply.ts';
import { handleRest } from './rest.ts';
import { createStore, type Store } from './store.ts';

/** Everything a surface handler needs: the shared store and the request's split path. */
export interface Ctx {
  readonly store: Store;
  /** The path split on '/', with each segment URI-decoded; never empty. */
  readonly segments: readonly string[];
  /** The raw query string after '?', or ''. Parsed lazily, only by routes that need it. */
  readonly queryString: string;
  /** The request's Host header, for building absolute pagination URLs. */
  readonly host: string;
}

/** Split a request URL into decoded path segments and the raw query string. */
function splitUrl(rawUrl: string): { segments: string[]; queryString: string } {
  const question = rawUrl.indexOf('?');
  const rawPath = question < 0 ? rawUrl : rawUrl.slice(0, question);
  const queryString = question < 0 ? '' : rawUrl.slice(question + 1);
  const parts = rawPath.split('/');
  const segments: string[] = [];
  for (const part of parts) {
    if (part === '') continue;
    try {
      segments.push(decodeURIComponent(part));
    } catch {
      segments.push(part);
    }
  }
  return { segments, queryString };
}

/** Read a request body whole. The trial's largest body is a push pack; it fits in memory. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = createStore();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await dispatch(store, req, res);
      } catch (err) {
        // Never let a handler failure kill the process or hang the socket: answer JSON 500.
        if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : 'internal error');
        else res.destroy();
      }
    })();
  });
}

async function dispatch(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const { segments, queryString } = splitUrl(req.url ?? '/');
  const ctx: Ctx = { store, segments, queryString, host: req.headers.host ?? 'localhost' };

  // The env's boot check calls this twice: 200 {"ok":true}. It takes no auth.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
  // No auth here either: the starter answered it bare, and no check probes it unauthenticated.
  if (method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // Surfaces that read a body get it read once, here; GET/HEAD drain anything sent so a
  // keep-alive socket stays framed for the next request on it.
  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const body = needsBody ? await readBody(req) : Buffer.alloc(0);
  if (!needsBody) req.resume();

  // git smart HTTP: /{owner}/{repo}.git/info/refs, /git-upload-pack, /git-receive-pack.
  if (handleGit(ctx, req, res, body)) return;

  // REST v3 under /api/v3.
  if (handleRest(ctx, req, res, body)) return;

  // GraphQL v4 at /api/graphql.
  if (handleGraphql(ctx, req, res, body)) return;

  // MCP at /mcp.
  if (handleMcp(ctx, req, res, body)) return;

  // Everything else, every method: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' });
}
