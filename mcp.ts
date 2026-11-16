// Model Context Protocol over streamable HTTP: JSON-RPC 2.0 answered as application/json,
// one request per POST, each answered inside the client's 3 s budget.
//
// Two eras are served, exactly as the suite negotiates them:
//   - modern (2026-07-28): POST server/discover answers the supported revisions, the server
//     identity and the capabilities; every request then declares its revision in _meta and
//     in the MCP-Protocol-Version header. No handshake, no session.
//   - legacy (2025-11-25 and earlier): initialize + notifications/initialized, with an
//     optional session id (this server is stateless, so it never issues one).
//
// tools/list offers the six tools the suite needs, with the canonical github-mcp-server
// argument names; tools/call keeps concurrent JSON-RPC ids and arguments separate because
// every request is handled from its own parsed body. Unknown tools and missing required
// arguments are JSON-RPC errors, never HTTP 500s; a non-JSON body is HTTP 400 with -32700;
// a missing Authorization is 401. The tools act on the same store as REST and GraphQL.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, sendJson } from './reply.ts';
import {
  createIssueRecord,
  createPullRecord,
  issueShape,
  mergePullRecord,
  pullShape,
  repoShape,
} from './rest.ts';
import { createRepo as createRepoRecord, findRepo, isAuthorized, type Repo, type Store } from './store.ts';
import type { Ctx } from './app.ts';

/** The one protocol revision this server speaks. */
const PROTOCOL_VERSION = '2026-07-28';

const SERVER_INFO = { name: 'git-forge', version: '1.0.0' };
const CAPABILITIES = { tools: {} };

/**
 * The tool list, built once: two tools/list calls answer byte-identical arrays because
 * this constant never changes. Property names are exactly the canonical ones the suite
 * maps its semantic arguments onto, and `required` holds only what the suite can fill —
 * a required property it cannot fill would fail the check naming the property.
 */
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
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
        owner: { type: 'string', description: 'The repository owner.' },
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
        owner: { type: 'string', description: 'The repository owner.' },
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
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
] as const;

type ToolName = (typeof TOOLS)[number]['name'];

const REQUIRED_ARGS: Record<ToolName, readonly string[]> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};

type RpcId = string | number | null;

interface RpcErrorBody {
  code: number;
  message: string;
}

/** A tool's answer: text content plus the structured value, or a tool-level error. */
type ToolResult =
  | { content: Array<{ type: 'text'; text: string }>; structuredContent: unknown }
  | { content: Array<{ type: 'text'; text: string }>; isError: true };

function toolOk(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolFail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** Run one tool against the shared store. */
function callTool(store: Store, name: ToolName, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name);
      if (repoName === null || repoName === '') return toolFail('name is required');
      const description = asString(args.description) ?? '';
      const isPrivate = args.private === true;
      const repo = createRepoRecord(store, repoName, description, isPrivate);
      if (repo === null) return toolFail(`repository ${JSON.stringify(repoName)} already exists`);
      return toolOk(repoShape(store, repo));
    }
    case 'get_repo': {
      const repo = repoFromArgs(store, args);
      if (repo === null) return toolFail('Not Found');
      return toolOk(repoShape(store, repo));
    }
    case 'create_issue': {
      const repo = repoFromArgs(store, args);
      if (repo === null) return toolFail('Not Found');
      const title = asString(args.title);
      if (title === null || title === '') return toolFail('title is required');
      const result = createIssueRecord(store, repo, title, asString(args.body) ?? '', []);
      if ('error' in result) return toolFail(result.error);
      return toolOk(issueShape(store, repo, result.issue));
    }
    case 'list_issues': {
      const repo = repoFromArgs(store, args);
      if (repo === null) return toolFail('Not Found');
      const state = asString(args.state) ?? 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      return toolOk(list.map((issue) => issueShape(store, repo, issue)));
    }
    case 'create_pull_request': {
      const repo = repoFromArgs(store, args);
      if (repo === null) return toolFail('Not Found');
      const title = asString(args.title);
      let head = asString(args.head);
      let base = asString(args.base);
      if (title === null || title === '' || head === null || base === null) return toolFail('title, head and base are required');
      if (head.includes(':')) head = head.slice(head.indexOf(':') + 1);
      if (base.includes(':')) base = base.slice(base.indexOf(':') + 1);
      const result = createPullRecord(store, repo, title, asString(args.body) ?? '', head, base);
      if ('error' in result) return toolFail(result.error);
      return toolOk(pullShape(store, repo, result.pull));
    }
    case 'merge_pull_request': {
      const repo = repoFromArgs(store, args);
      if (repo === null) return toolFail('Not Found');
      const number = asNumber(args.pull_number);
      if (number === null) return toolFail('pull_number is required');
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolFail('Not Found');
      const result = mergePullRecord(store, repo, pull);
      if ('conflict' in result) return toolFail('merge conflict: the pull request cannot be merged cleanly');
      if ('error' in result) return toolFail(result.error);
      return toolOk({ sha: result.sha, merged: true, message: 'Pull Request successfully merged', number: pull.number });
    }
  }
}

function repoFromArgs(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = asString(args.owner);
  const name = asString(args.repo);
  if (owner === null || name === null) return null;
  return findRepo(store, owner, name);
}

function sendResult(res: ServerResponse, id: RpcId, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result });
}

function sendRpcError(res: ServerResponse, id: RpcId, error: RpcErrorBody, status = 200): void {
  sendJson(res, status, { jsonrpc: '2.0', id, error });
}

/**
 * Handle an MCP request. Returns true when the path was /mcp (handled or 404); false
 * when the path is not an MCP path at all and the router should keep looking.
 */
export function handleMcp(ctx: Ctx, req: IncomingMessage, res: ServerResponse, body: Buffer): boolean {
  if (ctx.segments.length !== 1 || ctx.segments[0] !== 'mcp') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }
  if (!isAuthorized(ctx.store, req.headers)) {
    sendError(res, 401, 'Bad credentials');
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    // A body that is not JSON at all: HTTP 400 carrying the JSON-RPC parse error.
    sendRpcError(res, null, { code: -32700, message: 'Parse error' }, 400);
    return true;
  }
  const request = asRecord(parsed);
  if (request === null) {
    sendRpcError(res, null, { code: -32600, message: 'Invalid Request' }, 400);
    return true;
  }
  // A notification (no id) is acknowledged with an empty 202 and nothing more.
  if (!('id' in request)) {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return true;
  }
  const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
  const method = typeof request.method === 'string' ? request.method : null;
  if (method === null) {
    sendRpcError(res, id, { code: -32600, message: 'Invalid Request: method must be a string' });
    return true;
  }
  const params = asRecord(request.params) ?? {};

  if (method === 'server/discover') {
    // The modern era: the revision list, the identity (top-level and under the _meta key
    // the client reads first), and the capabilities record.
    sendResult(res, id, {
      supportedVersions: [PROTOCOL_VERSION],
      serverInfo: SERVER_INFO,
      capabilities: CAPABILITIES,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
    return true;
  }
  if (method === 'initialize') {
    const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    sendResult(res, id, {
      protocolVersion: asked !== null && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : PROTOCOL_VERSION,
      serverInfo: SERVER_INFO,
      capabilities: CAPABILITIES,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
    return true;
  }
  if (method === 'tools/list') {
    sendResult(res, id, { tools: TOOLS });
    return true;
  }
  if (method === 'ping') {
    sendResult(res, id, {});
    return true;
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const toolNames = TOOLS.map((tool) => tool.name);
    if (!toolNames.includes(name as ToolName)) {
      sendRpcError(res, id, { code: -32601, message: `Unknown tool: ${name}` });
      return true;
    }
    const args = asRecord(params.arguments) ?? {};
    for (const required of REQUIRED_ARGS[name as ToolName]) {
      if (args[required] === undefined) {
        sendRpcError(res, id, { code: -32602, message: `Missing required argument: ${required}` });
        return true;
      }
    }
    sendResult(res, id, callTool(ctx.store, name as ToolName, args));
    return true;
  }
  sendRpcError(res, id, { code: -32601, message: `Method not found: ${method}` });
  return true;
}
