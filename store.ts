// The forge's whole state: one in-memory store, built once per process, shared by every
// surface (REST, GraphQL and MCP all read and write the same repos, issues and pull
// requests, so an object created through one surface is visible through the others with
// the same ids).
//
// DETERMINISM. A contender's trial runs twice and the exports must match byte for byte, so
// nothing here reads a clock or a random source at request time:
//   - every timestamp comes from MAKEFUN_TRIAL_NOW, parsed once at startup into `nowSec`
//     (a fixed constant only when the variable is unset, for local runs);
//   - every id is a sequential counter or a content hash;
//   - the request id is a sequential counter (reply.ts);
//   - iteration order is insertion order (Maps), never hash order.
// There is deliberately no use of Date.now, new Date, Math.random or random UUIDs anywhere
// in this program.

/** The object types git stores. */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** A git object: its type and its exact bytes (no header; the id hashes header + bytes). */
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/** A label on a repository. */
export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
}

/** A comment on an issue or a pull request (one number space, one comment list). */
export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly author: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** An issue. `id` is a stable global counter, distinct from the per-repo `number`. */
export interface Issue {
  readonly number: number;
  readonly id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly labels: string[];
  readonly author: string;
  readonly createdAt: string;
  updatedAt: string;
}

/** A pull request. Head/base SHAs are snapshotted at creation; the live branch tips are read on demand. */
export interface Pull {
  readonly number: number;
  readonly id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly author: string;
  readonly createdAt: string;
  updatedAt: string;
}

/** A cached fetch answer: the pack bytes plus the shallow/ack lines that go with them. */
export interface CachedPack {
  readonly pack: Buffer;
  readonly shallow: readonly string[];
  readonly unshallow: readonly string[];
  readonly acks: readonly string[];
  readonly nak: boolean;
}

/** One repository: its git objects and refs plus its REST/GraphQL/MCP resources. */
export interface Repo {
  readonly name: string;
  readonly databaseId: number;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  /** Objects by id. Every object a push, a contents write or a merge creates lands here. */
  readonly objects: Map<string, GitObject>;
  /** Refname -> tip id. */
  readonly refs: Map<string, string>;
  /** Labels keyed by lowercase name, so lookup is case-insensitive. */
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, Pull>;
  /** Comments keyed by issue/PR number (the two share one number space). */
  readonly comments: Map<number, Comment[]>;
  /** The next issue/PR number. Issues and pull requests share one counter, as on GitHub. */
  nextNumber: number;
  /** Bumped on every mutation; caches are valid only for the version they were built at. */
  version: number;
  /** Fetch packs, keyed by the request signature (wants/haves/depth/boundary). */
  readonly packCache: Map<string, CachedPack>;
  /** Advertisement bytes, rebuilt whenever the version moves. */
  advCache: { version: number; uploadV2: Buffer; uploadV0: Buffer; receiveV0: Buffer } | null;
  /** ls-refs answers, keyed by the argument signature. */
  readonly lsrefsCache: Map<string, Buffer>;
  /** Serialized JSON GET answers, keyed by route + params. */
  readonly jsonCache: Map<string, Buffer>;
}

/** The whole store: the clock, the credential, the viewer, and every repository. */
export interface Store {
  /** The trial instant, Unix seconds, parsed once at startup. */
  readonly nowSec: number;
  /** The same instant as an ISO-8601 string, formatted once and reused for every timestamp. */
  readonly nowIso: string;
  /** The bearer token API calls must present; null when unset (local runs accept any token). */
  readonly token: string | null;
  /** The token owner's login, learned from the first owner segment that names a live repo. */
  viewerLogin: string | null;
  /** Repositories keyed by name: the entry serves one owner, so names are the namespace. */
  readonly repos: Map<string, Repo>;
  nextDatabaseId: number;
  nextEntityId: number;
  nextCommentId: number;
}

/** 2025-01-01T00:00:00Z, the scenario epoch: the fallback instant when MAKEFUN_TRIAL_NOW is unset. */
export const FALLBACK_NOW_SEC = 1735689600;

/** The identity server-created commits (contents writes, squash merges) carry. */
export const FORGE_IDENTITY = 'git-forge <forge@git-forge.local>';

/** Parse MAKEFUN_TRIAL_NOW: epoch seconds, epoch milliseconds when large, or an ISO string. */
function parseTrialNow(raw: string | undefined): number {
  if (raw === undefined) return FALLBACK_NOW_SEC;
  const trimmed = raw.trim();
  if (trimmed === '') return FALLBACK_NOW_SEC;
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) {
    const sec = asNumber > 1e11 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
    return sec > 0 ? sec : FALLBACK_NOW_SEC;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  return FALLBACK_NOW_SEC;
}

/**
 * Format Unix seconds as ISO-8601 UTC without touching the Date object: a civil-date
 * conversion (Howard Hinnant's algorithm), so the output is a pure function of the input.
 */
export function formatIso(sec: number): string {
  const days = Math.floor(sec / 86400);
  const rem = sec - days * 86400;
  const hh = Math.floor(rem / 3600);
  const mm = Math.floor((rem % 3600) / 60);
  const ss = rem % 60;
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const year = y + (m <= 2 ? 1 : 0);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${p2(m)}-${p2(d)}T${p2(hh)}:${p2(mm)}:${p2(ss)}Z`;
}

/** Build the store: parse the trial clock and credential once, start every counter at 1. */
export function createStore(): Store {
  const nowSec = parseTrialNow(process.env.MAKEFUN_TRIAL_NOW);
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return {
    nowSec,
    nowIso: formatIso(nowSec),
    token: token === '' ? null : token,
    viewerLogin: null,
    repos: new Map(),
    nextDatabaseId: 1,
    nextEntityId: 1,
    nextCommentId: 1,
  };
}

/** The bearer token on a request, or null when the header is absent or malformed. */
export function bearerToken(headers: { authorization?: string | string[] | undefined }): string | null {
  const raw = headers.authorization;
  if (typeof raw !== 'string') return null;
  if (!raw.startsWith('Bearer ')) return null;
  const token = raw.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

/**
 * Whether a request is authenticated: the presented token must equal MAKEFUN_SHOP_TOKEN.
 * With no token configured (a local run), any non-empty bearer token passes; a missing one
 * never does.
 */
export function isAuthorized(store: Store, headers: { authorization?: string | string[] | undefined }): boolean {
  const presented = bearerToken(headers);
  if (presented === null) return false;
  if (store.token === null) return true;
  return presented === store.token;
}

/** The viewer's login once learned, else the fallback used before any owner is seen. */
export function viewerLoginOf(store: Store): string {
  return store.viewerLogin ?? 'viewer';
}

/**
 * Find a repository by owner and name. The first lookup of a live repo teaches the store the
 * viewer's login (the token is opaque, so the owner segment is the only signal); afterwards
 * any other owner is a 404, never a 403. A lookup that finds nothing teaches nothing, so a
 * probe for a stranger's missing repo can never poison the learned login.
 */
export function findRepo(store: Store, owner: string, name: string): Repo | null {
  const repo = store.repos.get(name);
  if (repo === undefined) return null;
  if (store.viewerLogin === null) store.viewerLogin = owner;
  else if (store.viewerLogin !== owner) return null;
  return repo;
}

/** Create a repository in the single-owner namespace, or null when the name is taken. */
export function createRepo(store: Store, name: string, description: string, isPrivate: boolean): Repo | null {
  if (store.repos.has(name)) return null;
  const repo: Repo = {
    name,
    databaseId: store.nextDatabaseId++,
    description,
    isPrivate,
    defaultBranch: 'main',
    createdAt: store.nowIso,
    updatedAt: store.nowIso,
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    comments: new Map(),
    nextNumber: 1,
    version: 0,
    packCache: new Map(),
    advCache: null,
    lsrefsCache: new Map(),
    jsonCache: new Map(),
  };
  store.repos.set(name, repo);
  return repo;
}

/** Mark a repository mutated: bump the version and drop every cache built from its old state. */
export function touch(repo: Repo): void {
  repo.version += 1;
  repo.packCache.clear();
  repo.advCache = null;
  repo.lsrefsCache.clear();
  repo.jsonCache.clear();
}
