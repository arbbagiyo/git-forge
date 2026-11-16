// One place for every HTTP reply the forge sends, so the headers the suite checks are
// never forgotten on any route: a JSON content type on JSON replies, and a non-empty
// X-GitHub-Request-Id on every reply at all.
//
// The request id is a sequential counter, never random and never clock-derived: two runs
// that serve the same requests in the same order emit the same ids.

import type { ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;

/** The next deterministic request id. */
export function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq}`;
}

/** Headers every reply carries, plus any the caller adds (the caller wins on collision). */
function baseHeaders(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { 'x-github-request-id': nextRequestId(), ...extra };
}

/** Answer with a JSON body (a trailing newline, as the starter did). */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    ...baseHeaders(headers),
  });
  res.end(text);
}

/** Answer with prebuilt bytes (a cached JSON body, a packfile, a pkt-line stream). */
export function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    ...baseHeaders(headers),
  });
  res.end(body);
}

/** Answer with no body but a JSON content type (204s still carry one). */
export function sendEmpty(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': JSON_TYPE, ...baseHeaders(headers) });
  res.end();
}

/** Answer with GitHub's error shape: a JSON body carrying a string `message`. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}
