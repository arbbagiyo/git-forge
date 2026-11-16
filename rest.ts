// GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments,
// pull requests, files and merges, under /api/v3.
//
// Every reply is JSON (never HTML) with a non-empty X-GitHub-Request-Id (reply.ts); errors
// carry a JSON body with a string `message`; an unknown route is a 404 and a malformed JSON
// body is a 400. Every route except the API root (app.ts) and /meta requires the bearer
// token; a missing or wrong token is a 401.
//
// This module also owns the shared domain operations — creating issues, pull requests and
// comments, and merging — which the GraphQL and MCP surfaces call into, so all three
// surfaces act on the same store with the same ids and the same rules.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  EMPTY_TREE_OID,
  buildCommit,
  buildTreeFromMap,
  flattenTree,
  hashObject,
  isOid,
  listDir,
  lookupPath,
  mergeBase,
  parseCommit,
  peelToCommit,
  removePathFromTree,
  setPathInTree,
  walkHistory,
} from './gitproto.ts';
import { JSON_TYPE, sendBuffer, sendEmpty, sendError, sendJson } from './reply.ts';
import {
  FORGE_IDENTITY,
  createRepo as createRepoRecord,
  findRepo,
  formatIso,
  isAuthorized,
  touch,
  viewerLoginOf,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import type { Ctx } from './app.ts';

/** Parse a JSON request body: {} when empty, null when malformed or not an object. */
function parseJsonBody(body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** One query parameter from a raw query string, or null. */
function queryParam(queryString: string, name: string): string | null {
  for (const pair of queryString.split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    if (decodeURIComponent(key) === name) return eq < 0 ? '' : decodeURIComponent(pair.slice(eq + 1));
  }
  return null;
}

/** A cached serialized GET answer; the cache is dropped by touch() on any mutation. */
function cached(repo: Repo, key: string, build: () => unknown): Buffer {
  const hit = repo.jsonCache.get(key);
  if (hit !== undefined) return hit;
  const buf = Buffer.from(`${JSON.stringify(build())}\n`, 'utf8');
  if (repo.jsonCache.size > 512) repo.jsonCache.clear();
  repo.jsonCache.set(key, buf);
  return buf;
}

/** Send a cached JSON body. */
function sendCached(res: ServerResponse, repo: Repo, key: string, build: () => unknown): void {
  sendBuffer(res, 200, cached(repo, key, build), JSON_TYPE);
}

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

function userShape(login: string): Record<string, unknown> {
  return { login, id: 1, type: 'User', site_admin: false };
}

export function repoShape(store: Store, repo: Repo): Record<string, unknown> {
  const viewer = viewerLoginOf(store);
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${viewer}/${repo.name}`,
    owner: userShape(viewer),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    fork: false,
    archived: false,
    disabled: false,
    url: `/api/v3/repos/${viewer}/${repo.name}`,
    html_url: `https://github.com/${viewer}/${repo.name}`,
    clone_url: `https://github.com/${viewer}/${repo.name}.git`,
  };
}

function labelShape(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: '', default: false };
}

function issueLabels(repo: Repo, names: readonly string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const name of names) {
    const label = repo.labels.get(name.toLowerCase());
    if (label !== undefined) out.push(labelShape(label));
  }
  return out;
}

export function issueShape(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const viewer = viewerLoginOf(store);
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userShape(issue.author),
    labels: issueLabels(repo, issue.labels),
    comments: repo.comments.get(issue.number)?.length ?? 0,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    url: `/api/v3/repos/${viewer}/${repo.name}/issues/${issue.number}`,
    html_url: `https://github.com/${viewer}/${repo.name}/issues/${issue.number}`,
  };
}

/** A pull request read through the issues API: the issue fields plus a pull_request marker. */
function pullAsIssueShape(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const viewer = viewerLoginOf(store);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: userShape(pull.author),
    labels: [],
    comments: repo.comments.get(pull.number)?.length ?? 0,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    pull_request: {
      url: `/api/v3/repos/${viewer}/${repo.name}/pulls/${pull.number}`,
      html_url: `https://github.com/${viewer}/${repo.name}/pull/${pull.number}`,
      merged_at: pull.mergedAt,
    },
    url: `/api/v3/repos/${viewer}/${repo.name}/issues/${pull.number}`,
    html_url: `https://github.com/${viewer}/${repo.name}/issues/${pull.number}`,
  };
}

/** The live tip of a branch, or the snapshot taken at PR creation when the branch is gone. */
function branchTipOr(repo: Repo, branch: string, fallback: string): string {
  return repo.refs.get(`refs/heads/${branch}`) ?? fallback;
}

export function pullShape(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const viewer = viewerLoginOf(store);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: userShape(pull.author),
    head: { ref: pull.headRef, sha: branchTipOr(repo, pull.headRef, pull.headSha), repo: repoShape(store, repo) },
    base: { ref: pull.baseRef, sha: branchTipOr(repo, pull.baseRef, pull.baseSha), repo: repoShape(store, repo) },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? computeMergeable(repo, pull) : null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    url: `/api/v3/repos/${viewer}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${viewer}/${repo.name}/pull/${pull.number}`,
  };
}

function commentShape(store: Store, repo: Repo, number: number, comment: Comment): Record<string, unknown> {
  const viewer = viewerLoginOf(store);
  return {
    id: comment.id,
    body: comment.body,
    user: userShape(comment.author),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    url: `/api/v3/repos/${viewer}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${viewer}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
  };
}

// ---------------------------------------------------------------------------------------------
// shared domain operations (REST, GraphQL and MCP all call these)
// ---------------------------------------------------------------------------------------------

/** Create an issue; `labelNames` must all exist. Returns the issue or an error message. */
export function createIssueRecord(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  labelNames: readonly string[],
): { issue: Issue } | { error: string } {
  if (title === '') return { error: 'title is required' };
  const labels: string[] = [];
  for (const name of labelNames) {
    const label = repo.labels.get(name.toLowerCase());
    if (label === undefined) return { error: `label ${JSON.stringify(name)} does not exist` };
    labels.push(label.name);
  }
  const issue: Issue = {
    number: repo.nextNumber++,
    id: store.nextEntityId++,
    title,
    body,
    state: 'open',
    labels,
    author: viewerLoginOf(store),
    createdAt: store.nowIso,
    updatedAt: store.nowIso,
  };
  repo.issues.set(issue.number, issue);
  touch(repo);
  return { issue };
}

/** Create a pull request; both branches must exist and no open duplicate may. */
export function createPullRecord(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): { pull: Pull } | { error: string } {
  if (title === '') return { error: 'title is required' };
  const headTip = repo.refs.get(`refs/heads/${headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
  if (headTip === undefined) return { error: `head branch ${JSON.stringify(headRef)} does not exist` };
  if (baseTip === undefined) return { error: `base branch ${JSON.stringify(baseRef)} does not exist` };
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
      return { error: 'a pull request already exists for these branches' };
    }
  }
  const pull: Pull = {
    number: repo.nextNumber++,
    id: store.nextEntityId++,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    headSha: headTip,
    baseSha: baseTip,
    author: viewerLoginOf(store),
    createdAt: store.nowIso,
    updatedAt: store.nowIso,
  };
  repo.pulls.set(pull.number, pull);
  touch(repo);
  return { pull };
}

/** Append a comment to an issue or pull request number. */
export function addCommentRecord(store: Store, repo: Repo, number: number, body: string): Comment {
  const comment: Comment = {
    id: store.nextCommentId++,
    body,
    author: viewerLoginOf(store),
    createdAt: store.nowIso,
    updatedAt: store.nowIso,
  };
  let list = repo.comments.get(number);
  if (list === undefined) {
    list = [];
    repo.comments.set(number, list);
  }
  list.push(comment);
  touch(repo);
  return comment;
}

// ---------------------------------------------------------------------------------------------
// three-way merge
// ---------------------------------------------------------------------------------------------

/**
 * Merge `headTree` into `baseTree` with `ancestorTree` as the merge-base: a path takes the
 * side that changed it, takes either when both sides agree, and conflicts when both sides
 * changed it differently (including delete-vs-modify). Returns the merged flat map, or null
 * on conflict.
 */
export function threeWayMerge(
  repo: Repo,
  ancestorTree: string,
  baseTree: string,
  headTree: string,
): Map<string, { oid: string; mode: string }> | null {
  const ancestor = flattenTree(repo, ancestorTree);
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const paths = new Set<string>([...ancestor.keys(), ...base.keys(), ...head.keys()]);
  const merged = new Map<string, { oid: string; mode: string }>();
  for (const path of paths) {
    const a = ancestor.get(path);
    const b = base.get(path);
    const h = head.get(path);
    const bOid = b?.oid;
    const hOid = h?.oid;
    const aOid = a?.oid;
    if (bOid === hOid) {
      if (b !== undefined) merged.set(path, b);
    } else if (aOid === bOid) {
      if (h !== undefined) merged.set(path, h);
    } else if (aOid === hOid) {
      if (b !== undefined) merged.set(path, b);
    } else {
      return null;
    }
  }
  return merged;
}

/** The two tips a merge works from: the live branch tips, falling back to the snapshots. */
function mergeTips(repo: Repo, pull: Pull): { baseTip: string; headTip: string } {
  return {
    baseTip: branchTipOr(repo, pull.baseRef, pull.baseSha),
    headTip: branchTipOr(repo, pull.headRef, pull.headSha),
  };
}

/** Whether a pull request merges cleanly: false on conflict, null when it cannot be computed. */
export function computeMergeable(repo: Repo, pull: Pull): boolean | null {
  const { baseTip, headTip } = mergeTips(repo, pull);
  const baseObject = repo.objects.get(baseTip);
  const headObject = repo.objects.get(headTip);
  if (baseObject?.type !== 'commit' || headObject?.type !== 'commit') return null;
  const base = mergeBase(repo, baseTip, headTip);
  const ancestorTree = base === null ? EMPTY_TREE_OID : parseCommit(repo.objects.get(base)!.data).tree;
  const merged = threeWayMerge(repo, ancestorTree, parseCommit(baseObject.data).tree, parseCommit(headObject.data).tree);
  return merged !== null;
}

/**
 * Squash-merge a pull request: one commit on the base branch whose parent is the base tip
 * and whose tree is the three-way merge. Returns the merge commit id, or a failure reason.
 */
export function mergePullRecord(
  store: Store,
  repo: Repo,
  pull: Pull,
): { sha: string } | { conflict: true } | { error: string } {
  if (pull.merged) return { error: 'the pull request is already merged' };
  if (pull.state !== 'open') return { error: 'the pull request is closed' };
  const { baseTip, headTip } = mergeTips(repo, pull);
  const baseObject = repo.objects.get(baseTip);
  const headObject = repo.objects.get(headTip);
  if (baseObject?.type !== 'commit' || headObject?.type !== 'commit') return { error: 'a branch tip is missing' };
  const base = mergeBase(repo, baseTip, headTip);
  const ancestorTree = base === null ? EMPTY_TREE_OID : parseCommit(repo.objects.get(base)!.data).tree;
  const merged = threeWayMerge(repo, ancestorTree, parseCommit(baseObject.data).tree, parseCommit(headObject.data).tree);
  if (merged === null) return { conflict: true };
  const treeOid = buildTreeFromMap(repo, merged);
  const ident = `${FORGE_IDENTITY} ${store.nowSec} +0000`;
  const commitData = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    authorLine: ident,
    committerLine: ident,
    message: `${pull.title} (#${pull.number})`,
  });
  const sha = hashObject('commit', commitData);
  repo.objects.set(sha, { type: 'commit', data: commitData });
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = store.nowIso;
  pull.mergeCommitSha = sha;
  pull.updatedAt = store.nowIso;
  touch(repo);
  return { sha };
}

// ---------------------------------------------------------------------------------------------
// line diffs for pull request files
// ---------------------------------------------------------------------------------------------

/** Split content into lines the way a diff counts them (a trailing newline ends the last line). */
function diffLinesOf(data: Buffer): string[] {
  if (data.length === 0) return [];
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Additions/deletions between two blobs, from the LCS length (two-row DP, capped). */
export function countLineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldLines = diffLinesOf(oldData);
  const newLines = diffLinesOf(newData);
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
  if (oldLines.length * newLines.length > 250_000) return { additions: newLines.length, deletions: oldLines.length };
  let prev = new Array<number>(newLines.length + 1).fill(0);
  let curr = new Array<number>(newLines.length + 1).fill(0);
  for (let i = 1; i <= oldLines.length; i += 1) {
    for (let j = 1; j <= newLines.length; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  const lcs = prev[newLines.length];
  return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
}

/** The file diff between two trees: one entry per changed path, sorted by filename. */
export function diffTrees(
  repo: Repo,
  baseTree: string,
  headTree: string,
): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; sha: string }> {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; sha: string }> = [];
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    const oldData = b === undefined ? Buffer.alloc(0) : (repo.objects.get(b.oid)?.data ?? Buffer.alloc(0));
    const newData = h === undefined ? Buffer.alloc(0) : (repo.objects.get(h.oid)?.data ?? Buffer.alloc(0));
    const { additions, deletions } = countLineDiff(oldData, newData);
    const status = b === undefined ? 'added' : h === undefined ? 'removed' : 'modified';
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions, sha: (h ?? b)!.oid });
  }
  out.sort((x, y) => (x.filename < y.filename ? -1 : x.filename > y.filename ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------------------------
// ref resolution for contents/commits (?ref=)
// ---------------------------------------------------------------------------------------------

/** Resolve a ref parameter to a commit id: branch name, full ref, tag name, or raw id. */
function resolveRef(repo: Repo, ref: string | null, fallbackBranch: string): string | null {
  const name = ref ?? fallbackBranch;
  const direct = repo.refs.get(name) ?? repo.refs.get(`refs/heads/${name}`) ?? repo.refs.get(`refs/tags/${name}`);
  if (direct !== undefined) {
    const object = repo.objects.get(direct);
    if (object?.type === 'commit') return direct;
    if (object?.type === 'tag') return peelToCommit(repo, direct);
    return null;
  }
  if (isOid(name)) {
    const object = repo.objects.get(name);
    if (object?.type === 'commit') return name;
    if (object?.type === 'tag') return peelToCommit(repo, name);
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------------------------

function handleUserRepos(ctx: Ctx, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const store = ctx.store;
  const method = req.method ?? 'GET';
  if (method === 'GET') {
    const perPageRaw = Number(queryParam(ctx.queryString, 'per_page') ?? '30');
    const pageRaw = Number(queryParam(ctx.queryString, 'page') ?? '1');
    const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.floor(perPageRaw))) : 30;
    const page = Number.isFinite(pageRaw) ? Math.max(1, Math.floor(pageRaw)) : 1;
    const all = [...store.repos.values()];
    const totalPages = Math.max(1, Math.ceil(all.length / perPage));
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const base = `http://${ctx.host}/api/v3/user/repos?per_page=${perPage}`;
    const links: string[] = [];
    if (page < totalPages) links.push(`<${base}&page=${page + 1}>; rel="next"`);
    if (totalPages > 1) links.push(`<${base}&page=${totalPages}>; rel="last"`);
    if (page > 1) {
      links.push(`<${base}&page=1>; rel="first"`);
      links.push(`<${base}&page=${page - 1}>; rel="prev"`);
    }
    sendJson(res, 200, slice.map((repo) => repoShape(store, repo)), links.length > 0 ? { link: links.join(', ') } : {});
    return;
  }
  if (method === 'POST') {
    const parsed = parseJsonBody(body);
    if (parsed === null) {
      sendError(res, 400, 'request body is not a JSON object');
      return;
    }
    const name = typeof parsed.name === 'string' ? parsed.name : '';
    if (name === '') {
      sendError(res, 422, 'name is required');
      return;
    }
    const description = typeof parsed.description === 'string' ? parsed.description : '';
    const isPrivate = parsed.private === true;
    const repo = createRepoRecord(store, name, description, isPrivate);
    if (repo === null) {
      sendError(res, 422, `repository ${JSON.stringify(name)} already exists`);
      return;
    }
    sendJson(res, 201, repoShape(store, repo));
    return;
  }
  sendError(res, 404, 'Not Found');
}

function handleRepoRoot(ctx: Ctx, req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const store = ctx.store;
  const method = req.method ?? 'GET';
  if (method === 'GET') {
    sendCached(res, repo, `repo:${ctx.queryString}`, () => repoShape(store, repo));
    return;
  }
  if (method === 'PATCH') {
    const parsed = parseJsonBody(body);
    if (parsed === null) {
      sendError(res, 400, 'request body is not a JSON object');
      return;
    }
    if (typeof parsed.description === 'string') repo.description = parsed.description;
    if (typeof parsed.private === 'boolean') repo.isPrivate = parsed.private;
    repo.updatedAt = store.nowIso;
    touch(repo);
    sendJson(res, 200, repoShape(store, repo));
    return;
  }
  if (method === 'DELETE') {
    store.repos.delete(repo.name);
    sendEmpty(res, 204);
    return;
  }
  sendError(res, 404, 'Not Found');
}

function handleGitRefs(ctx: Ctx, req: IncomingMessage, res: ServerResponse, repo: Repo, rest: readonly string[], body: Buffer): void {
  const method = req.method ?? 'GET';
  if (method === 'POST' && rest.length === 0) {
    const parsed = parseJsonBody(body);
    if (parsed === null) {
      sendError(res, 400, 'request body is not a JSON object');
      return;
    }
    const ref = typeof parsed.ref === 'string' ? parsed.ref : '';
    const sha = typeof parsed.sha === 'string' ? parsed.sha : '';
    if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
      sendError(res, 422, 'ref must name refs/ and sha must name an object the repository holds');
      return;
    }
    if (repo.refs.has(ref)) {
      sendError(res, 422, `ref ${JSON.stringify(ref)} already exists`);
      return;
    }
    repo.refs.set(ref, sha);
    touch(repo);
    const object = repo.objects.get(sha)!;
    sendJson(res, 201, { ref, object: { sha, type: object.type } });
    return;
  }
  if (method === 'GET') {
    if (rest.length === 0) {
      const all = sortedRefNames(repo).map((ref) => ({ ref, object: { sha: repo.refs.get(ref)!, type: repo.objects.get(repo.refs.get(ref)!)?.type ?? 'commit' } }));
      sendJson(res, 200, all);
      return;
    }
    const refName = `refs/${rest.join('/')}`;
    const sha = repo.refs.get(refName);
    if (sha !== undefined) {
      const object = repo.objects.get(sha);
      sendJson(res, 200, { ref: refName, object: { sha, type: object?.type ?? 'commit' } });
      return;
    }
    const prefixed = sortedRefNames(repo).filter((ref) => ref.startsWith(`${refName}/`) || ref === refName);
    if (prefixed.length > 0) {
      sendJson(res, 200, prefixed.map((ref) => ({ ref, object: { sha: repo.refs.get(ref)!, type: repo.objects.get(repo.refs.get(ref)!)?.type ?? 'commit' } })));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  sendError(res, 404, 'Not Found');
}

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function branchNames(repo: Repo): string[] {
  const names: string[] = [];
  for (const ref of repo.refs.keys()) {
    if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
  }
  names.sort();
  return names;
}

function handleBranches(ctx: Ctx, req: IncomingMessage, res: ServerResponse, repo: Repo, rest: readonly string[]): void {
  const method = req.method ?? 'GET';
  if (method !== 'GET') {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (rest.length === 0) {
    sendCached(res, repo, `branches:${ctx.queryString}`, () =>
      branchNames(repo).map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`)! }, protected: false })),
    );
    return;
  }
  const branch = rest.join('/');
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  sendCached(res, repo, `branch:${branch}`, () => {
    const object = repo.objects.get(sha);
    const message = object?.type === 'commit' ? parseCommit(object.data).message : '';
    return { name: branch, commit: { sha, commit: { message } }, protected: false };
  });
}

/** Split an ident line `Name <email> ts tz` into its display parts. */
function splitIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: '' };
  return { name: match[1], email: match[2], date: formatIso(Number(match[3])) };
}

function handleCommits(ctx: Ctx, req: IncomingMessage, res: ServerResponse, repo: Repo): void {
  if ((req.method ?? 'GET') !== 'GET') {
    sendError(res, 404, 'Not Found');
    return;
  }
  const shaParam = queryParam(ctx.queryString, 'sha');
  const tip = resolveRef(repo, shaParam, repo.defaultBranch);
  if (tip === null) {
    if (shaParam !== null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, []);
    return;
  }
  sendCached(res, repo, `commits:${shaParam ?? ''}`, () =>
    walkHistory(repo, tip).map((sha) => {
      const commit = parseCommit(repo.objects.get(sha)!.data);
      const author = splitIdent(commit.author);
      const committer = splitIdent(commit.committer);
      return {
        sha,
        commit: {
          message: commit.message,
          author: { name: author.name, email: author.email, date: author.date },
          committer: { name: committer.name, email: committer.email, date: committer.date },
        },
        parents: commit.parents.map((p) => ({ sha: p })),
      };
    }),
  );
}

function handleContents(ctx: Ctx, req: IncomingMessage, res: ServerResponse, repo: Repo, rest: readonly string[], body: Buffer): void {
  const store = ctx.store;
  const method = req.method ?? 'GET';
  const path = rest.join('/');
  if (method === 'GET') {
    const refParam = queryParam(ctx.queryString, 'ref');
    const tip = resolveRef(repo, refParam, repo.defaultBranch);
    if (tip === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const tree = parseCommit(repo.objects.get(tip)!.data).tree;
    // Resolve the path before touching the cache: a miss is a 404, never a cached null.
    const entries = listDir(repo, tree, path);
    let value: unknown;
    if (entries !== null) {
      value = entries.map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: entry.path,
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
      }));
    } else {
      const file = lookupPath(repo, tree, path);
      const object = file === null ? undefined : repo.objects.get(file.oid);
      if (file === null || object === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      value = {
        type: 'file',
        encoding: 'base64',
        size: object.data.length,
        name: path.split('/').pop() ?? path,
        path,
        sha: file.oid,
        content: object.data.toString('base64'),
      };
    }
    sendCached(res, repo, `contents:${path}:${refParam ?? ''}`, () => value);
    return;
  }
  if (method === 'PUT' || method === 'DELETE') {
    const parsed = parseJsonBody(body);
    if (parsed === null) {
      sendError(res, 400, 'request body is not a JSON object');
      return;
    }
    if (path === '') {
      sendError(res, 422, 'a file path is required');
      return;
    }
    const branch = typeof parsed.branch === 'string' && parsed.branch !== '' ? parsed.branch : repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    if (tip === undefined) {
      // A branch must exist to write to it — except the default branch of a repo with no
      // refs at all, where the write is the first commit and creates the branch.
      if (!(repo.refs.size === 0 && branch === repo.defaultBranch)) {
        sendError(res, 422, `branch ${JSON.stringify(branch)} does not exist`);
        return;
      }
    }
    const message = typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : `Update ${path}`;
    const currentTree = tip === undefined ? null : parseCommit(repo.objects.get(tip)!.data).tree;
    const existing = currentTree === null ? null : lookupPath(repo, currentTree, path);
    const isDir = currentTree !== null && existing === null && listDir(repo, currentTree, path) !== null;
    const givenSha = typeof parsed.sha === 'string' ? parsed.sha : null;

    if (method === 'DELETE') {
      if (existing === null || isDir) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (givenSha !== null && givenSha !== existing.oid) {
        sendError(res, 409, 'sha does not match the current file');
        return;
      }
      const newTree = removePathFromTree(repo, currentTree!, path);
      const sha = writeServerCommit(store, repo, newTree, tip === undefined ? [] : [tip], message);
      repo.refs.set(refName, sha);
      touch(repo);
      sendJson(res, 200, { commit: { sha, message }, content: null });
      return;
    }

    // PUT: create (201) or update (200).
    if (isDir) {
      sendError(res, 422, 'a directory exists at that path');
      return;
    }
    if (givenSha !== null) {
      if (existing === null) {
        sendError(res, 422, 'sha names a file that does not exist');
        return;
      }
      if (givenSha !== existing.oid) {
        sendError(res, 409, 'sha does not match the current file');
        return;
      }
    }
    const content = typeof parsed.content === 'string' ? parsed.content : null;
    if (content === null) {
      sendError(res, 422, 'content is required');
      return;
    }
    const blobData = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
    const blobOid = hashObject('blob', blobData);
    if (!repo.objects.has(blobOid)) repo.objects.set(blobOid, { type: 'blob', data: blobData });
    let newTree: string;
    try {
      newTree = setPathInTree(repo, currentTree, path, blobOid, '100644');
    } catch {
      sendError(res, 422, 'a file blocks the path');
      return;
    }
    const sha = writeServerCommit(store, repo, newTree, tip === undefined ? [] : [tip], message);
    repo.refs.set(refName, sha);
    touch(repo);
    sendJson(res, existing === null ? 201 : 200, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: blobData.length, encoding: 'base64', type: 'file' },
      commit: { sha, message },
    });
    return;
  }
  sendError(res, 404, 'Not Found');
}

/** Create and store a server-authored commit (contents writes, merges use their own). */
function writeServerCommit(store: Store, repo: Repo, tree: string, parents: readonly string[], message: string): string {
  const ident = `${FORGE_IDENTITY} ${store.nowSec} +0000`;
  const data = buildCommit({ tree, parents, authorLine: ident, committerLine: ident, message });
  const sha = hashObject('commit', data);
  repo.objects.set(sha, { type: 'commit', data });
  return sha;
}

function handleLabels(ctx: Ctx, req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const store = ctx.store;
  const method = req.method ?? 'GET';
  if (method === 'GET') {
    sendCached(res, repo, `labels:${ctx.queryString}`, () => [...repo.labels.values()].map(labelShape));
    return;
  }
  if (method === 'POST') {
    const parsed = parseJsonBody(body);
    if (parsed === null) {
      sendError(res, 400, 'request body is not a JSON object');
      return;
    }
    const name = typeof parsed.name === 'string' ? parsed.name : '';
    if (name === '') {
      sendError(res, 422, 'name is required');
      return;
    }
    if (repo.labels.has(name.toLowerCase())) {
      sendError(res, 422, `label ${JSON.stringify(name)} already exists`);
      return;
    }
    const color = typeof parsed.color === 'string' && parsed.color !== '' ? parsed.color : '000000';
    const label: Label = { id: store.nextEntityId++, name, color };
    repo.labels.set(name.toLowerCase(), label);
    touch(repo);
    sendJson(res, 201, labelShape(label));
    return;
  }
  sendError(res, 404, 'Not Found');
}

function parseNumber(segment: string): number | null {
  if (!/^\d+$/.test(segment)) return null;
  const n = Number(segment);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

function handleIssues(ctx: Ctx, req: IncomingMessage, res: ServerResponse, repo: Repo, rest: readonly string[], body: Buffer): void {
  const store = ctx.store;
  const method = req.method ?? 'GET';
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = queryParam(ctx.queryString, 'state') ?? 'open';
      const direction = queryParam(ctx.queryString, 'direction') ?? 'desc';
      sendCached(res, repo, `issues:${ctx.queryString}`, () => {
        let list = [...repo.issues.values()];
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        return list.map((issue) => issueShape(store, repo, issue));
      });
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed === null) {
        sendError(res, 400, 'request body is not a JSON object');
        return;
      }
      const title = typeof parsed.title === 'string' ? parsed.title : '';
      const issueBody = typeof parsed.body === 'string' ? parsed.body : '';
      const labelNames = Array.isArray(parsed.labels) ? parsed.labels.filter((l): l is string => typeof l === 'string') : [];
      const result = createIssueRecord(store, repo, title, issueBody, labelNames);
      if ('error' in result) {
        sendError(res, 422, result.error);
        return;
      }
      sendJson(res, 201, issueShape(store, repo, result.issue));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  const number = parseNumber(rest[0]);
  if (number === null) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const issue = repo.issues.get(number);
  const pull = repo.pulls.get(number);
  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined && pull === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      sendCached(res, repo, `comments:${number}`, () => (repo.comments.get(number) ?? []).map((c) => commentShape(store, repo, number, c)));
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed === null) {
        sendError(res, 400, 'request body is not a JSON object');
        return;
      }
      const commentBody = typeof parsed.body === 'string' ? parsed.body : '';
      if (commentBody === '') {
        sendError(res, 422, 'body is required');
        return;
      }
      const comment = addCommentRecord(store, repo, number, commentBody);
      sendJson(res, 201, commentShape(store, repo, number, comment));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  if (rest.length === 1) {
    if (method === 'GET') {
      if (issue !== undefined) {
        sendCached(res, repo, `issue:${number}`, () => issueShape(store, repo, issue));
        return;
      }
      if (pull !== undefined) {
        sendCached(res, repo, `issue:${number}`, () => pullAsIssueShape(store, repo, pull));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }
    if (method === 'PATCH') {
      if (issue === undefined && pull === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const parsed = parseJsonBody(body);
      if (parsed === null) {
        sendError(res, 400, 'request body is not a JSON object');
        return;
      }
      if (issue !== undefined) {
        if (parsed.state === 'open' || parsed.state === 'closed') issue.state = parsed.state;
        if (typeof parsed.title === 'string') issue.title = parsed.title;
        if (typeof parsed.body === 'string') issue.body = parsed.body;
        issue.updatedAt = store.nowIso;
        touch(repo);
        sendJson(res, 200, issueShape(store, repo, issue));
        return;
      }
      if (parsed.state === 'open' || parsed.state === 'closed') pull!.state = parsed.state;
      if (typeof parsed.title === 'string') pull!.title = parsed.title;
      if (typeof parsed.body === 'string') pull!.body = parsed.body;
      pull!.updatedAt = store.nowIso;
      touch(repo);
      sendJson(res, 200, pullAsIssueShape(store, repo, pull!));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  sendError(res, 404, 'Not Found');
}

function handlePulls(ctx: Ctx, req: IncomingMessage, res: ServerResponse, repo: Repo, rest: readonly string[], body: Buffer): void {
  const store = ctx.store;
  const method = req.method ?? 'GET';
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = queryParam(ctx.queryString, 'state') ?? 'open';
      sendCached(res, repo, `pulls:${ctx.queryString}`, () => {
        let list = [...repo.pulls.values()];
        if (state === 'open') list = list.filter((p) => p.state === 'open');
        else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        list.sort((a, b) => b.number - a.number);
        return list.map((pull) => pullShape(store, repo, pull));
      });
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (parsed === null) {
        sendError(res, 400, 'request body is not a JSON object');
        return;
      }
      const title = typeof parsed.title === 'string' ? parsed.title : '';
      const pullBody = typeof parsed.body === 'string' ? parsed.body : '';
      let head = typeof parsed.head === 'string' ? parsed.head : '';
      let base = typeof parsed.base === 'string' ? parsed.base : '';
      if (head.includes(':')) head = head.slice(head.indexOf(':') + 1);
      if (base.includes(':')) base = base.slice(base.indexOf(':') + 1);
      const result = createPullRecord(store, repo, title, pullBody, head, base);
      if ('error' in result) {
        sendError(res, 422, result.error);
        return;
      }
      sendJson(res, 201, pullShape(store, repo, result.pull));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  const number = parseNumber(rest[0]);
  if (number === null) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendCached(res, repo, `files:${number}`, () => {
      const { baseTip, headTip } = mergeTips(repo, pull);
      const baseObject = repo.objects.get(baseTip);
      const headObject = repo.objects.get(headTip);
      if (baseObject?.type !== 'commit' || headObject?.type !== 'commit') return [];
      return diffTrees(repo, parseCommit(baseObject.data).tree, parseCommit(headObject.data).tree);
    });
    return;
  }
  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') {
      sendError(res, 404, 'Not Found');
      return;
    }
    const parsed = parseJsonBody(body);
    if (parsed === null) {
      sendError(res, 400, 'request body is not a JSON object');
      return;
    }
    void parsed;
    const result = mergePullRecord(store, repo, pull);
    if ('conflict' in result) {
      sendError(res, 405, 'merge conflict: the pull request cannot be merged cleanly');
      return;
    }
    if ('error' in result) {
      sendError(res, 405, result.error);
      return;
    }
    sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  if (rest.length === 1) {
    if (method === 'GET') {
      sendCached(res, repo, `pull:${number}`, () => pullShape(store, repo, pull));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------------------------

/**
 * Handle a REST v3 request. Returns true when the path was under /api/v3 (handled or 404);
 * false when the path is not a REST path at all and the router should keep looking.
 */
export function handleRest(ctx: Ctx, req: IncomingMessage, res: ServerResponse, body: Buffer): boolean {
  if (ctx.segments.length < 3 || ctx.segments[0] !== 'api' || ctx.segments[1] !== 'v3') return false;
  const tail = ctx.segments.slice(2);

  // /meta takes no auth, like the API root.
  if (tail.length === 1 && tail[0] === 'meta' && (req.method ?? 'GET') === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  if (!isAuthorized(ctx.store, req.headers)) {
    sendError(res, 401, 'Bad credentials');
    return true;
  }

  if (tail.length === 1 && tail[0] === 'user' && (req.method ?? 'GET') === 'GET') {
    sendJson(res, 200, { ...userShape(viewerLoginOf(ctx.store)), name: viewerLoginOf(ctx.store) });
    return true;
  }

  if (tail.length >= 2 && tail[0] === 'user' && tail[1] === 'repos' && tail.length === 2) {
    handleUserRepos(ctx, req, res, body);
    return true;
  }

  if (tail.length >= 3 && tail[0] === 'repos') {
    const repo = findRepo(ctx.store, tail[1], tail[2]);
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const rest = tail.slice(3);
    if (rest.length === 0) {
      handleRepoRoot(ctx, req, res, repo, body);
      return true;
    }
    const [head, ...restTail] = rest;
    if (head === 'git' && restTail.length >= 1 && restTail[0] === 'refs') {
      handleGitRefs(ctx, req, res, repo, restTail.slice(1), body);
      return true;
    }
    if (head === 'branches') {
      handleBranches(ctx, req, res, repo, restTail);
      return true;
    }
    if (head === 'commits' && restTail.length === 0) {
      handleCommits(ctx, req, res, repo);
      return true;
    }
    if (head === 'contents') {
      handleContents(ctx, req, res, repo, restTail, body);
      return true;
    }
    if (head === 'labels' && restTail.length === 0) {
      handleLabels(ctx, req, res, repo, body);
      return true;
    }
    if (head === 'issues') {
      handleIssues(ctx, req, res, repo, restTail, body);
      return true;
    }
    if (head === 'pulls') {
      handlePulls(ctx, req, res, repo, restTail, body);
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  sendError(res, 404, 'Not Found');
  return true;
}
