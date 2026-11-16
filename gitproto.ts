// The git wire and object formats, implemented from the formats themselves: pkt-line
// framing, SHA-1 object ids, commit/tree/tag parsing and building, packfile reading
// (with OFS_DELTA and REF_DELTA resolution) and writing (plain objects, no deltas — the
// suite resolves whatever it is sent, and plain packs keep the server fast), and the
// reachability walks that decide what a fetch sends and whether a push fast-forwards.
//
// Nothing here touches the network or the filesystem. Every function is a pure function
// of its inputs plus the repository's object map.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, GitObjectType, Repo } from './store.ts';

/** The all-zero id: an unborn ref's value, and a create/delete marker in push commands. */
export const ZERO_OID = '0'.repeat(40);

/** git's LARGE_PACKET_MAX: the largest pkt-line including its 4-byte length header. */
export const PKT_LINE_MAX = 65520;

/** An error in the git wire format or object model: the caller turns it into a 400 or an unpack error, never a crash. */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

/** True for a lowercase 40-hex object id. */
export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------------------------

export type Packet =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/** Encode one data packet: a 4-hex length (payload + 4) then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new GitError(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX - 4}-byte maximum`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode a sequence; 'flush'/'delim' are the control packets. */
export function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/**
 * Decode pkt-lines from `buf` starting at `start`, stopping after the first flush packet
 * (or at the end of the buffer). Returns the packets and the offset just past the last one
 * consumed, so a receive-pack caller finds its pack bytes in the remainder.
 */
export function decodePackets(buf: Buffer, start = 0): { packets: Packet[]; restOffset: number } {
  const packets: Packet[] = [];
  let offset = start;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new GitError(`truncated pkt-line: ${buf.length - offset} trailing byte(s)`);
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new GitError(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) throw new GitError(`invalid pkt-line length ${length}`);
    if (offset + length > buf.length) throw new GitError(`truncated pkt-line: ${length} announced, ${buf.length - offset} available`);
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, restOffset: offset };
}

/** The text of the data packets, control packets dropped, trailing newlines stripped. */
export function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// object ids and the object model
// ---------------------------------------------------------------------------------------------

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\u0000`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** The id of the empty tree, computed once (it is a content hash like any other). */
export const EMPTY_TREE_OID = hashObject('tree', Buffer.alloc(0));

/** A parsed tree entry. `mode` is git's ASCII mode (`100644`, `40000`, `120000`, `160000`). */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new GitError('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new GitError('tree entry has no name terminator');
    if (nul + 21 > data.length) throw new GitError('tree entry has a truncated object id');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    if (!/^[0-7]+$/.test(mode)) throw new GitError(`tree entry mode ${JSON.stringify(mode)} is not octal`);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isOid(entry.oid)) throw new GitError(`tree entry ${entry.name} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** A parsed commit: the fields the forge reasons about, plus the message verbatim. */
export interface CommitView {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new GitError('commit has no valid tree header');
  for (const parent of parents) if (!isOid(parent)) throw new GitError('commit has a bad parent id');
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. Author/committer arrive as full ident lines. */
export function buildCommit(fields: { tree: string; parents: readonly string[]; authorLine: string; committerLine: string; message: string }): Buffer {
  if (!isOid(fields.tree)) throw new GitError('buildCommit needs a valid tree id');
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) {
    if (!isOid(parent)) throw new GitError('buildCommit needs valid parent ids');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${fields.authorLine}`, `committer ${fields.committerLine}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** A parsed annotated tag. */
export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new GitError(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isOid(object)) throw new GitError('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') throw new GitError(`tag has bad type ${JSON.stringify(type)}`);
  return { object, type: type as GitObjectType, tag: headers.get('tag') ?? '', tagger: headers.get('tagger') ?? '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
}

/**
 * Peel a tag (through tag chains) to the commit it names, or null when the chain does not
 * end at a commit held by the repo.
 */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
}

// ---------------------------------------------------------------------------------------------
// packfile reading
// ---------------------------------------------------------------------------------------------

const PACK_TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Read a pack entry's type/size varint. */
function readEntryHeader(buf: Buffer, start: number): { size: number; typeCode: number; next: number } {
  if (start >= buf.length) throw new GitError('pack entry has no size header');
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new GitError('pack entry size varint is truncated');
    byte = buf[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new GitError('pack entry size varint is too long');
  }
  return { size, typeCode: (first >> 4) & 0x07, next: offset };
}

/** Read an OFS_DELTA base offset (the distance back from the entry's own offset). */
function readOfsBase(buf: Buffer, start: number): { distance: number; next: number } {
  if (start >= buf.length) throw new GitError('ofs-delta has no base offset');
  let byte = buf[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buf.length) throw new GitError('ofs-delta base offset is truncated');
    byte = buf[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { distance: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buf: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset, end);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new GitError(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new GitError(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (the copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new GitError('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new GitError('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new GitError(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new GitError('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new GitError('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new GitError('delta copy is out of the base');
      if (written + copySize > targetSize) throw new GitError('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new GitError('delta insert is truncated');
      if (written + literal > targetSize) throw new GitError('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new GitError('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new GitError(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackRead {
  readonly version: number;
  readonly declaredCount: number;
  readonly objects: Map<string, GitObject>;
  readonly checksumOk: boolean;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA and
 * REF_DELTA entries. `resolveBase` supplies a base a thin pack leaves out (an object the
 * repo already holds). Structural corruption throws GitError; a bad trailer checksum is
 * reported on the result instead, so the caller can answer an unpack error.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 32) throw new GitError(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new GitError('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new GitError(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  const checksumOk = trailer === computed;

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readEntryHeader(pack, offset);
    offset = header.next;
    const entry: Raw = { offset: entryOffset, typeCode: header.typeCode, size: header.size, data: Buffer.alloc(0) };
    if (header.typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      if (base.distance <= 0 || base.distance > entryOffset) throw new GitError(`ofs-delta at ${entryOffset} names an invalid base offset`);
      entry.baseOffset = entryOffset - base.distance;
    } else if (header.typeCode === 7) {
      if (offset + 20 > trailerStart) throw new GitError('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (PACK_CODE_TYPE[header.typeCode] === undefined) {
      throw new GitError(`pack entry ${index} has unknown type code ${header.typeCode}`);
    }
    const inflated = inflateAt(pack, offset, trailerStart);
    if (inflated.data.length !== header.size) {
      throw new GitError(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new GitError(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new GitError(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new GitError(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (external === undefined) throw new GitError(`ref-delta base ${wanted} is neither in the pack nor in the store`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = PACK_CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { version, declaredCount, objects, checksumOk };
}

// ---------------------------------------------------------------------------------------------
// packfile writing
// ---------------------------------------------------------------------------------------------

/** Encode one object's pack header: the type/size varint the pack format uses. */
function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = PACK_TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a packfile from plain objects (no deltas), in the caller's order. The trailer is
 * SHA-1 over everything before it. An empty list yields the valid 32-byte empty pack.
 */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/**
 * Every object reachable from `roots`: commit -> tree + parents, tree -> entries (gitlinks
 * skipped: they name commits the repo does not hold), tag -> its target. Missing objects are
 * skipped when `allowMissing` is set, so a have-list can name objects the repo never held.
 */
export function collectReachable(repo: Repo, roots: Iterable<string>, allowMissing = false): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) {
      if (allowMissing) continue;
      throw new GitError(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Whether `ancestor` is reachable from `descendant` by following parents (or equal to it). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/**
 * The merge-base of two commits: the common ancestor minimising the sum of the distances
 * from both tips, ties broken by the smallest id (so the choice is deterministic).
 */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const distA = new Map<string, number>();
  const queueA: Array<[string, number]> = [[a, 0]];
  while (queueA.length > 0) {
    const [oid, dist] = queueA.shift()!;
    if (distA.has(oid)) continue;
    distA.set(oid, dist);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push([parent, dist + 1]);
  }
  let best: string | null = null;
  let bestTotal = Number.POSITIVE_INFINITY;
  const seenB = new Set<string>();
  const queueB: Array<[string, number]> = [[b, 0]];
  while (queueB.length > 0) {
    const [oid, dist] = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const da = distA.get(oid);
    if (da !== undefined) {
      const total = da + dist;
      if (total < bestTotal || (total === bestTotal && (best === null || oid < best))) {
        best = oid;
        bestTotal = total;
      }
    }
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push([parent, dist + 1]);
  }
  return best;
}

/** The history of a tip, newest first: a pre-order walk following parents in stored order. */
export function walkHistory(repo: Repo, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    order.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
  }
  return order;
}

// ---------------------------------------------------------------------------------------------
// fetch planning: what a fetch sends, what stays shallow, what is acknowledged
// ---------------------------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects to pack, in deterministic discovery order. */
  readonly objects: GitObject[];
  /** Commits at the depth boundary whose parents were cut. */
  readonly shallow: string[];
  /** Former boundary commits whose parents are now included. */
  readonly unshallow: string[];
  /** Haves that are genuine common bases of the wants. */
  readonly acks: string[];
  /** True when no have was acknowledged (the client negotiates from nothing). */
  readonly nak: boolean;
}

/**
 * Plan one fetch. `wants` are the tips (commits or tags) the client asked for, `haves` the
 * commits it already holds, `boundary` its current shallow boundary, `depth` the deepen
 * limit (undefined for a full fetch).
 *
 * Included: the want closure within the depth limit, minus everything reachable from the
 * haves, minus the boundary commits and their tree/blob closures (a shallow clone already
 * holds those, but not their parents). Shallow lines name included commits at the depth
 * edge whose parents were cut; unshallow lines name boundary commits whose parents are now
 * included or already held.
 */
export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  boundary: readonly string[],
  depth: number | undefined,
): FetchPlan {
  // Resolve wants: tags contribute themselves plus their peeled target; anything the repo
  // does not hold is ignored (a fetch for an unknown tip answers an empty pack, not an error).
  const tagObjects: GitObject[] = [];
  const commitRoots: string[] = [];
  const directObjects: GitObject[] = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagObjects.push(object);
      let target = parseTag(object.data).object;
      const seenTags = new Set<string>([want]);
      for (;;) {
        const next = repo.objects.get(target);
        if (next === undefined) break;
        if (next.type === 'tag') {
          if (seenTags.has(target)) break;
          seenTags.add(target);
          tagObjects.push(next);
          target = parseTag(next.data).object;
          continue;
        }
        if (next.type === 'commit') commitRoots.push(target);
        else directObjects.push(next);
        break;
      }
    } else if (object.type === 'commit') {
      commitRoots.push(want);
    } else {
      directObjects.push(object);
    }
  }

  // Distances from the wants, bounded by depth (a commit at distance d has d parent edges
  // between it and a want; depth 1 is the tips alone).
  const dist = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const root of commitRoots) queue.push([root, 0]);
  while (queue.length > 0) {
    const [oid, d] = queue.shift()!;
    if (dist.has(oid)) continue;
    dist.set(oid, d);
    if (depth !== undefined && d + 1 >= depth) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push([parent, d + 1]);
  }

  // Everything the client already holds. Without a depth limit, the full have
  // closure is excluded: an incremental fetch never re-sends history the
  // client holds, and a held tip fetches nothing. WITH a depth limit, the
  // haves (and the boundary lines) mark only themselves, plus their tree/blob
  // closures, as held — their parents inside the depth window are still
  // delivered. That is the deepen flow: a client holding the tip at depth 1
  // asks for depth 2 with have=shallow=tip, and must receive exactly one more
  // generation, not an empty pack.
  const excluded = new Set<string>();
  const heldSelf = (tip: string): void => {
    const object = repo.objects.get(tip);
    if (object === undefined) return;
    excluded.add(tip);
    if (object.type !== 'commit') return;
    const treeClosure = collectReachable(repo, [parseCommit(object.data).tree], true);
    for (const oid of treeClosure) excluded.add(oid);
  };
  if (depth === undefined) {
    for (const oid of collectReachable(repo, haves, true)) excluded.add(oid);
    for (const tip of boundary) heldSelf(tip);
  } else {
    for (const tip of [...haves, ...boundary]) heldSelf(tip);
  }

  // Included commits, in BFS discovery order (the queue order above is deterministic).
  const includedCommits: string[] = [];
  const included = new Set<string>();
  const commitOrder = [...dist.keys()];
  for (const oid of commitOrder) {
    if (excluded.has(oid)) continue;
    included.add(oid);
    includedCommits.push(oid);
  }

  // Trees and blobs of the included commits, in first-discovery order.
  const objects: GitObject[] = [];
  const emitted = new Set<string>();
  const emit = (oid: string): void => {
    if (emitted.has(oid) || excluded.has(oid)) return;
    const object = repo.objects.get(oid);
    if (object === undefined) return;
    emitted.add(oid);
    objects.push(object);
  };
  for (const tag of tagObjects) {
    const oid = hashObject(tag.type, tag.data);
    if (!excluded.has(oid) && !emitted.has(oid)) {
      emitted.add(oid);
      objects.push(tag);
    }
  }
  for (const direct of directObjects) {
    const oid = hashObject(direct.type, direct.data);
    if (!excluded.has(oid) && !emitted.has(oid)) {
      emitted.add(oid);
      objects.push(direct);
    }
  }
  for (const oid of includedCommits) {
    emit(oid);
    const commit = parseCommit(repo.objects.get(oid)!.data);
    // Depth-first through the tree so a tree precedes the blobs it names.
    const treeStack = [commit.tree];
    while (treeStack.length > 0) {
      const treeOid = treeStack.pop()!;
      if (emitted.has(treeOid) || excluded.has(treeOid)) continue;
      const treeObject = repo.objects.get(treeOid);
      if (treeObject === undefined || treeObject.type !== 'tree') continue;
      emitted.add(treeOid);
      objects.push(treeObject);
      const entries = parseTree(treeObject.data);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (entry.mode === '160000') continue;
        if (entry.mode === '40000') treeStack.push(entry.oid);
        else emit(entry.oid);
      }
    }
  }

  // Shallow: included commits at the depth edge with a parent that was cut (not included
  // and not already held). No depth limit means no shallow boundary at all.
  const shallow: string[] = [];
  if (depth !== undefined) {
    for (const oid of includedCommits) {
      if (dist.get(oid) !== depth - 1) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0) continue;
      const cut = parents.some((p) => !included.has(p) && !excluded.has(p));
      if (cut) shallow.push(oid);
    }
  }

  // Unshallow: boundary commits whose every parent is now included or already held.
  const unshallow: string[] = [];
  for (const tip of boundary) {
    const object = repo.objects.get(tip);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((p) => included.has(p) || excluded.has(p))) unshallow.push(tip);
  }

  // Acks: haves the repo holds that are reachable from the wants at any depth.
  const fullClosure = collectReachable(repo, commitRoots, true);
  const acks: string[] = [];
  for (const have of haves) {
    if (repo.objects.has(have) && fullClosure.has(have)) acks.push(have);
  }

  return { objects, shallow, unshallow, acks, nak: acks.length === 0 };
}

// ---------------------------------------------------------------------------------------------
// tree surgery: contents writes, deletes, merges and diffs
// ---------------------------------------------------------------------------------------------

/** Flatten a tree into path -> entry, recursing into directories (gitlinks kept as entries). */
export function flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const flat = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else flat.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return flat;
}

/** Build (and store) the tree for a flat path map, creating intermediate directories. */
export function buildTreeFromMap(repo: Repo, flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
  const items = [...flat].map(([path, value]) => ({ rel: path, oid: value.oid, mode: value.mode }));
  return buildLevel(repo, items);
}

/** One level of buildTreeFromMap: `items` are paths relative to this directory. */
function buildLevel(repo: Repo, items: ReadonlyArray<{ rel: string; oid: string; mode: string }>): string {
  const entries: TreeEntry[] = [];
  const dirs = new Map<string, Array<{ rel: string; oid: string; mode: string }>>();
  for (const item of items) {
    const slash = item.rel.indexOf('/');
    if (slash < 0) {
      entries.push({ mode: item.mode, name: item.rel, oid: item.oid });
    } else {
      const dir = item.rel.slice(0, slash);
      let list = dirs.get(dir);
      if (list === undefined) {
        list = [];
        dirs.set(dir, list);
      }
      list.push({ rel: item.rel.slice(slash + 1), oid: item.oid, mode: item.mode });
    }
  }
  for (const [dir, list] of dirs) entries.push({ mode: '40000', name: dir, oid: buildLevel(repo, list) });
  const data = buildTree(entries);
  const oid = hashObject('tree', data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
  return oid;
}

/** Look a path up in a tree: the blob (or gitlink) entry, or null when absent or a directory. */
export function lookupPath(repo: Repo, treeOid: string, path: string): { oid: string; mode: string } | null {
  const segments = path.split('/').filter((s) => s !== '');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) {
      if (entry.mode === '40000') return null;
      return { oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** List a directory in a tree: entries with full paths, or null when the path is not a directory. */
export function listDir(repo: Repo, treeOid: string, path: string): Array<{ name: string; path: string; oid: string; mode: string }> | null {
  let current = treeOid;
  const segments = path.split('/').filter((s) => s !== '');
  for (const segment of segments) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === segment);
    if (entry === undefined || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  const object = repo.objects.get(current);
  if (object === undefined || object.type !== 'tree') return null;
  return parseTree(object.data).map((entry) => ({
    name: entry.name,
    path: path === '' ? entry.name : `${path}/${entry.name}`,
    oid: entry.oid,
    mode: entry.mode,
  }));
}

/**
 * Return the root tree id after setting `path` to `blobOid` (creating intermediate
 * directories). Throws GitError when an intermediate segment is a file.
 */
export function setPathInTree(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string, mode: string): string {
  const segments = path.split('/').filter((s) => s !== '');
  if (segments.length === 0) throw new GitError('cannot write an empty path');
  const rewrite = (treeOid: string | null, depth: number): string => {
    const entries = new Map<string, TreeEntry>();
    if (treeOid !== null) {
      const object = repo.objects.get(treeOid);
      if (object !== undefined && object.type === 'tree') {
        for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
      }
    }
    const name = segments[depth];
    if (depth === segments.length - 1) {
      entries.set(name, { mode, name, oid: blobOid });
    } else {
      const existing = entries.get(name);
      if (existing !== undefined && existing.mode !== '40000') throw new GitError(`path ${segments.slice(0, depth + 1).join('/')} is a file`);
      const childOid = rewrite(existing?.oid ?? null, depth + 1);
      entries.set(name, { mode: '40000', name, oid: childOid });
    }
    const data = buildTree([...entries.values()]);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return rewrite(baseTreeOid, 0);
}

/**
 * Return the root tree id after removing `path`, pruning directories left empty. Throws
 * GitError when the path does not name a file in the tree.
 */
export function removePathFromTree(repo: Repo, baseTreeOid: string, path: string): string {
  const segments = path.split('/').filter((s) => s !== '');
  if (segments.length === 0) throw new GitError('cannot remove an empty path');
  const rewrite = (treeOid: string, depth: number): string | null => {
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') throw new GitError(`path ${path} does not exist`);
    const entries = new Map<string, TreeEntry>();
    for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
    const name = segments[depth];
    if (depth === segments.length - 1) {
      const existing = entries.get(name);
      if (existing === undefined || existing.mode === '40000') throw new GitError(`path ${path} does not exist`);
      entries.delete(name);
    } else {
      const existing = entries.get(name);
      if (existing === undefined || existing.mode !== '40000') throw new GitError(`path ${path} does not exist`);
      const childOid = rewrite(existing.oid, depth + 1);
      if (childOid === null) entries.delete(name);
      else entries.set(name, { mode: '40000', name, oid: childOid });
    }
    if (entries.size === 0) return null;
    const data = buildTree([...entries.values()]);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  const result = rewrite(baseTreeOid, 0);
  if (result === null) {
    if (!repo.objects.has(EMPTY_TREE_OID)) repo.objects.set(EMPTY_TREE_OID, { type: 'tree', data: Buffer.alloc(0) });
    return EMPTY_TREE_OID;
  }
  return result;
}
