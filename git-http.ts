// git smart HTTP: the `/{owner}/{repo}.git` surface.
//
//   GET  /info/refs?service=git-upload-pack    v2 capabilities when the client asks for
//                                              version 2 (it always does), else a v0 ref
//                                              advertisement with the `# service=` preamble
//   GET  /info/refs?service=git-receive-pack   always a v0 advertisement
//   POST /git-upload-pack                      protocol v2 (command=ls-refs / command=fetch)
//                                              with a v0 want/have fallback
//   POST /git-receive-pack                     protocol v0: command list + pack, report-status
//
// Repositories are created through REST only: a push to a repo that does not exist is a
// 404, and info/refs for a missing repo is a 404 too. The server never requires auth on
// this surface (the suite always authenticates anyway) and never dies on a malformed
// request: a bad pkt-line stream is a 400 and the next request is served as usual.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  GitError,
  ZERO_OID,
  decodePackets,
  isAncestor,
  isOid,
  packetLines,
  peelToCommit,
  planFetch,
  pktLine,
  pktLines,
  readPack,
  writePack,
  type Packet,
} from './gitproto.ts';
import { sendBuffer, sendError } from './reply.ts';
import { findRepo, touch, type Repo, type Store } from './store.ts';
import type { Ctx } from './app.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** v2 capabilities: fetch with shallow support, ls-refs, SHA-1 object format. */
const V2_CAPABILITIES = ['fetch=shallow', 'ls-refs', 'object-format=sha1'];
/** v0 upload-pack capabilities (the v0 fallback needs side-band-64k and shallow). */
const V0_UPLOAD_CAPS = 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow multi_ack';
/** v0 receive-pack capabilities: the suite requires report-status, side-band-64k, delete-refs. */
const V0_RECEIVE_CAPS = 'report-status side-band-64k delete-refs symref=HEAD:refs/heads/main ofs-delta';

/** Sideband payload cap: well under the pkt-line maximum, so framing is never the failure. */
const SIDEBAND_CHUNK = 32768;

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

/** The segments of a git path, or null when the path is not one: [owner, "<repo>.git", ...rest]. */
export function gitPathOf(ctx: Ctx): { owner: string; repo: string; rest: readonly string[] } | null {
  if (ctx.segments.length < 2) return null;
  const leaf = ctx.segments[1];
  if (!leaf.endsWith('.git') || leaf.length <= 4) return null;
  return { owner: ctx.segments[0], repo: leaf.slice(0, -4), rest: ctx.segments.slice(2) };
}

/** Decode a whole pkt-line body (every section), throwing GitError on malformed framing. */
function decodeAll(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const decoded = decodePackets(buf, offset);
    packets.push(...decoded.packets);
    if (decoded.restOffset <= offset) break;
    offset = decoded.restOffset;
  }
  return packets;
}

/** Split packets into flush-terminated sections, dropping the flush packets themselves. */
function sectionsOf(packets: readonly Packet[]): Packet[][] {
  const sections: Packet[][] = [];
  let current: Packet[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sections.push(current);
      current = [];
    } else {
      current.push(packet);
    }
  }
  if (current.length > 0) sections.push(current);
  return sections;
}

/** Sorted ref names, HEAD excluded (it is listed separately, first, in advertisements). */
function sortedRefs(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** The tip of the default branch, or the zero id when it is unborn. */
function headOid(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

/** Build all three advertisement bodies for the repo's current refs, in one pass. */
function buildAdvertisements(repo: Repo): { uploadV2: Buffer; uploadV0: Buffer; receiveV0: Buffer } {
  const uploadV2 = pktLines(['version 2\n', ...V2_CAPABILITIES.map((c) => `${c}\n`), 'flush']);

  const buildV0 = (service: string, caps: string): Buffer => {
    const parts: Buffer[] = [pktLine(`# service=${service}\n`), Buffer.from('0000', 'ascii')];
    const lines: string[] = [];
    const refs = sortedRefs(repo);
    if (refs.length === 0) {
      lines.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
    } else {
      lines.push(`${headOid(repo)} HEAD\u0000${caps}\n`);
      for (const ref of refs) {
        const oid = repo.refs.get(ref)!;
        lines.push(`${oid} ${ref}\n`);
        const object = repo.objects.get(oid);
        if (object !== undefined && object.type === 'tag') {
          const peeled = peelToCommit(repo, oid);
          if (peeled !== null) lines.push(`${peeled} ${ref}^{}\n`);
        }
      }
    }
    for (const line of lines) parts.push(pktLine(line));
    parts.push(Buffer.from('0000', 'ascii'));
    return Buffer.concat(parts);
  };

  return {
    uploadV2,
    uploadV0: buildV0('git-upload-pack', V0_UPLOAD_CAPS),
    receiveV0: buildV0('git-receive-pack', V0_RECEIVE_CAPS),
  };
}

/** The cached advertisements, rebuilt when the repo's version moved. */
function advertisements(repo: Repo): { uploadV2: Buffer; uploadV0: Buffer; receiveV0: Buffer } {
  const cached = repo.advCache;
  if (cached !== null && cached.version === repo.version) return cached;
  const built = buildAdvertisements(repo);
  repo.advCache = { version: repo.version, ...built };
  return repo.advCache;
}

function handleInfoRefs(ctx: Ctx, req: IncomingMessage, res: ServerResponse, repo: Repo): void {
  const service = queryParam(ctx.queryString, 'service');
  if (service === 'git-upload-pack') {
    const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    const ads = advertisements(repo);
    sendBuffer(res, 200, wantsV2 ? ads.uploadV2 : ads.uploadV0, UPLOAD_AD);
    return;
  }
  if (service === 'git-receive-pack') {
    sendBuffer(res, 200, advertisements(repo).receiveV0, RECEIVE_AD);
    return;
  }
  sendError(res, 400, 'info/refs needs a service=git-upload-pack or service=git-receive-pack query');
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------------------------

/** Answer a v2 ls-refs: one line per ref, HEAD first when symrefs was asked for. */
function handleLsRefs(repo: Repo, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') { /* unborn is not advertised; a request for it is ignored */ }
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const cacheKey = `peel=${peel ? 1 : 0};symrefs=${symrefs ? 1 : 0};prefixes=${prefixes.join(',')}`;
  const cached = repo.lsrefsCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const head = headOid(repo);
  if (symrefs && head !== ZERO_OID && keep('HEAD')) {
    lines.push(`${head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref)) continue;
    const oid = repo.refs.get(ref)!;
    let line = `${oid} ${ref}`;
    if (peel) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  const body = pktLines([...lines, 'flush']);
  if (repo.lsrefsCache.size > 64) repo.lsrefsCache.clear();
  repo.lsrefsCache.set(cacheKey, body);
  return body;
}

// ---------------------------------------------------------------------------------------------
// fetch (protocol v2 and the v0 fallback share one plan)
// ---------------------------------------------------------------------------------------------

/** The pack bytes for a fetch plan, cached per repo version under the request signature. */
function packFor(repo: Repo, wants: readonly string[], haves: readonly string[], boundary: readonly string[], depth: number | undefined): { pack: Buffer; shallow: readonly string[]; unshallow: readonly string[]; acks: readonly string[]; nak: boolean } {
  const key = JSON.stringify([[...wants].sort(), [...haves].sort(), [...boundary].sort(), depth ?? null]);
  const cached = repo.packCache.get(key);
  if (cached !== undefined) return cached;
  const plan = planFetch(repo, wants, haves, boundary, depth);
  const built = { pack: writePack(plan.objects), shallow: plan.shallow, unshallow: plan.unshallow, acks: plan.acks, nak: plan.nak };
  if (repo.packCache.size > 64) repo.packCache.clear();
  repo.packCache.set(key, built);
  return built;
}

/** Wrap bytes as sideband band-1 packets, chunked under the pkt-line maximum. */
function sideband(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

/** A v2 fetch answer: acknowledgments, shallow-info, then the packfile section. */
function fetchResponseV2(repo: Repo, wants: readonly string[], haves: readonly string[], boundary: readonly string[], depth: number | undefined): Buffer {
  const { pack, shallow, unshallow, acks, nak } = packFor(repo, wants, haves, boundary, depth);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (nak) parts.push(pktLine('NAK\n'));
  else for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  parts.push(Buffer.from('0000', 'ascii'));
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0000', 'ascii'));
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sideband(pack));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

/** A v0 fetch answer: shallow lines, NAK/ACKs, then the sideband pack. */
function fetchResponseV0(repo: Repo, wants: readonly string[], haves: readonly string[], boundary: readonly string[], depth: number | undefined): Buffer {
  const { pack, shallow, unshallow, acks, nak } = packFor(repo, wants, haves, boundary, depth);
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (nak) parts.push(pktLine('NAK\n'));
  else for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  parts.push(sideband(pack));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function handleUploadPack(repo: Repo, body: Buffer): Buffer {
  const packets = decodeAll(body);
  const lines = packetLines(packets);
  if (lines.length === 0) throw new GitError('empty upload-pack request');
  const first = lines[0];

  // Protocol v2: the first line names a command, a delim separates options from arguments.
  if (first.startsWith('command=')) {
    const command = first.slice('command='.length);
    const delimAt = packets.findIndex((p) => p.kind === 'delim');
    const argPackets = delimAt < 0 ? packets.slice(1) : packets.slice(delimAt + 1);
    const args = packetLines(argPackets);
    if (command === 'ls-refs') return handleLsRefs(repo, args);
    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const boundary: string[] = [];
      let depth: number | undefined;
      for (const arg of args) {
        if (arg.startsWith('want ') && isOid(arg.slice(5))) wants.push(arg.slice(5));
        else if (arg.startsWith('have ') && isOid(arg.slice(5))) haves.push(arg.slice(5));
        else if (arg.startsWith('shallow ') && isOid(arg.slice(8))) boundary.push(arg.slice(8));
        else if (arg.startsWith('deepen ')) {
          const n = Number(arg.slice(7));
          if (Number.isInteger(n) && n > 0) depth = n;
        }
        // thin-pack, no-progress, ofs-delta, filter, done: accepted, no action needed.
      }
      return fetchResponseV2(repo, wants, haves, boundary, depth);
    }
    throw new GitError(`unknown v2 command ${JSON.stringify(command)}`);
  }

  // Protocol v0: wants (with shallow/deepen) in the first section, haves in the second.
  const sections = sectionsOf(packets);
  const wants: string[] = [];
  const haves: string[] = [];
  const boundary: string[] = [];
  let depth: number | undefined;
  for (const line of packetLines(sections[0] ?? [])) {
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0];
      if (isOid(oid)) wants.push(oid);
    } else if (line.startsWith('shallow ') && isOid(line.slice(8))) {
      boundary.push(line.slice(8));
    } else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7));
      if (Number.isInteger(n) && n > 0) depth = n;
    }
  }
  for (const line of packetLines(sections[1] ?? [])) {
    if (line.startsWith('have ') && isOid(line.slice(5))) haves.push(line.slice(5));
  }
  if (wants.length === 0 && haves.length === 0 && boundary.length === 0) throw new GitError('v0 fetch names no wants');
  return fetchResponseV0(repo, wants, haves, boundary, depth);
}

// ---------------------------------------------------------------------------------------------
// receive-pack (protocol v0): command list + pack, per-ref report-status
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, restOffset } = decodePackets(body);
  const lines = packetLines(packets);
  const commands: PushCommand[] = [];
  let wantsSideband = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const nul = line.indexOf('\u0000');
    const caps = nul < 0 ? '' : line.slice(nul + 1);
    const head = nul < 0 ? line : line.slice(0, nul);
    const parts = head.split(' ');
    if (parts.length !== 3 || !isOid(parts[0]) || !isOid(parts[1]) || !parts[2].startsWith('refs/')) {
      throw new GitError(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    }
    if (i === 0 && caps.split(' ').includes('side-band-64k')) wantsSideband = true;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) throw new GitError('receive-pack with no commands');

  // Unpack first: the objects stay even when a ref update is refused, as in real git.
  const packBytes = body.subarray(restOffset);
  let unpackOk = true;
  let unpackDetail = 'ok';
  let ingested = false;
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => repo.objects.get(oid));
      if (!read.checksumOk) {
        unpackOk = false;
        unpackDetail = 'error pack checksum mismatch';
      } else {
        for (const [oid, object] of read.objects) {
          if (!repo.objects.has(oid)) {
            repo.objects.set(oid, object);
            ingested = true;
          }
        }
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = `error ${err instanceof Error ? err.message : 'unpack failed'}`;
    }
  }

  // Per-ref verdicts. A refusal never moves the ref; a mixed push applies what it can.
  const reports: string[] = [];
  let refsChanged = false;
  for (const command of commands) {
    if (!unpackOk) {
      reports.push(`ng ${command.ref} unpack error\n`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    let ok: boolean;
    if (command.newOid === ZERO_OID) {
      // Delete: allowed when the old value matches what the ref holds (or the ref is absent
      // and the old value is zero, a no-op delete).
      ok = current === command.oldOid || (current === undefined && command.oldOid === ZERO_OID);
      if (ok && current !== undefined) {
        repo.refs.delete(command.ref);
        refsChanged = true;
      }
    } else {
      // Create or update: the old value must match, and the new tip must descend from it
      // (or be identical to it). A create over an existing ref, a stale old value and a
      // divergent tip are all the same refusal: non-fast-forward.
      const objectKnown = repo.objects.has(command.newOid);
      if (current === undefined) {
        ok = objectKnown && command.oldOid === ZERO_OID;
      } else {
        ok = objectKnown && command.oldOid === current && (command.newOid === current || isAncestor(repo, current, command.newOid));
      }
      if (ok) {
        repo.refs.set(command.ref, command.newOid);
        refsChanged = true;
      }
    }
    reports.push(ok ? `ok ${command.ref}\n` : `ng ${command.ref} non-fast-forward\n`);
  }
  if (ingested || refsChanged) touch(repo);

  const reportLines = [`unpack ${unpackDetail}\n`, ...reports];
  const report = pktLines([...reportLines, 'flush']);
  if (!wantsSideband) return report;
  const parts: Buffer[] = [];
  for (let offset = 0; offset < report.length; offset += SIDEBAND_CHUNK) {
    const chunk = report.subarray(offset, Math.min(report.length, offset + SIDEBAND_CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------------------------

/**
 * Handle a git smart-HTTP request. Returns true when the path was a git path (handled or
 * 404); false when the path is not a git path at all and the router should keep looking.
 */
export function handleGit(ctx: Ctx, req: IncomingMessage, res: ServerResponse, body: Buffer): boolean {
  const path = gitPathOf(ctx);
  if (path === null) return false;
  const method = req.method ?? 'GET';
  const [head, ...tail] = path.rest;
  const isInfoRefs = method === 'GET' && head === 'info' && tail.length === 1 && tail[0] === 'refs';
  const isUpload = method === 'POST' && head === 'git-upload-pack' && tail.length === 0;
  const isReceive = method === 'POST' && head === 'git-receive-pack' && tail.length === 0;
  if (!isInfoRefs && !isUpload && !isReceive) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const repo = findRepo(ctx.store, path.owner, path.repo);
  if (repo === null) {
    // A push cannot invent a repository, and info/refs for a missing one is a 404.
    sendError(res, 404, 'Not Found');
    return true;
  }
  try {
    if (isInfoRefs) {
      handleInfoRefs(ctx, req, res, repo);
    } else if (isUpload) {
      sendBuffer(res, 200, handleUploadPack(repo, body), UPLOAD_RESULT);
    } else {
      sendBuffer(res, 200, handleReceivePack(repo, body), RECEIVE_RESULT);
    }
  } catch (err) {
    if (err instanceof GitError) {
      // A malformed pkt-line stream or pack: a 400, and the server stays up for the next call.
      sendError(res, 400, err.message);
    } else {
      throw err;
    }
  }
  return true;
}
