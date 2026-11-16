// GitHub GraphQL v4: a small executor for the documents `gh` and `github-mcp-server`
// send — no schema library, no validation pass, just the wire the suite speaks.
//
//   POST /api/graphql, {"query", "variables"} -> {"data", "errors"}.
//   Two documents in one body (a JSON array) -> two results, in order.
//   An unauthenticated request is exactly 401. A GraphQL-level failure (an unknown field)
//   is a 200 whose body carries `errors` naming the field, with the siblings resolved.
//
// The parser handles operation names, variable definitions and substitution, inline enum
// lists and input objects, aliases, inline and named fragments, and @skip/@include. The
// executor resolves against the same store as REST and MCP, so a mutation here is visible
// there with the same ids.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit } from './gitproto.ts';
import { sendError, sendJson } from './reply.ts';
import {
  addCommentRecord,
  computeMergeable,
  createIssueRecord,
  createPullRecord,
  diffTrees,
  mergePullRecord,
} from './rest.ts';
import { findRepo, isAuthorized, touch, viewerLoginOf, type Comment, type Issue, type Label, type Pull, type Repo, type Store } from './store.ts';
import type { Ctx } from './app.ts';

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'eof' };

class GqlParseError extends Error {}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():[]:!$@='.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new GqlParseError('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end).replace(/\\"""/g, '"""') });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < source.length) {
        const ch = source[j];
        if (ch === '"') {
          closed = true;
          break;
        }
        if (ch === '\n') throw new GqlParseError('unterminated string');
        if (ch === '\\') {
          const esc = source[j + 1];
          if (esc === 'u') {
            const hex = source.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GqlParseError('bad unicode escape');
            value += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
            continue;
          }
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (!(esc in map)) throw new GqlParseError(`bad escape \\${esc}`);
          value += map[esc];
          j += 2;
          continue;
        }
        value += ch;
        j += 1;
      }
      if (!closed) throw new GqlParseError('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        let k = j + 1;
        if (source[k] === '+' || source[k] === '-') k += 1;
        if (/[0-9]/.test(source[k] ?? '')) {
          isFloat = true;
          j = k;
          while (j < source.length && /[0-9]/.test(source[j])) j += 1;
        }
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GqlParseError(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

interface DirectiveNode {
  name: string;
  args: ArgumentNode[];
}

type SelectionNode =
  | { kind: 'field'; alias: string | null; name: string; args: ArgumentNode[]; directives: DirectiveNode[]; selectionSet: SelectionNode[] | null }
  | { kind: 'fragmentSpread'; name: string; directives: DirectiveNode[] }
  | { kind: 'inlineFragment'; typeCondition: string | null; directives: DirectiveNode[]; selectionSet: SelectionNode[] };

interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefs: Array<{ name: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new GqlParseError(`expected ${JSON.stringify(value)}`);
  }

  private eatPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.next();
      return true;
    }
    return false;
  }

  private expectName(what = 'a name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GqlParseError(`expected ${what}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    for (;;) {
      const token = this.peek();
      if (token.kind === 'eof') break;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, variableDefs: [], selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const operation = this.next().value as 'query' | 'mutation' | 'subscription';
        let name: string | null = null;
        const maybeName = this.peek();
        if (maybeName.kind === 'name') name = this.next().value;
        const variableDefs = this.parseVariableDefs();
        operations.push({ operation, name, variableDefs, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName('a fragment name');
        const on = this.expectName('on');
        if (on !== 'on') throw new GqlParseError('expected on in a fragment definition');
        const typeCondition = this.expectName('a type name');
        fragments.set(name, { name, typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new GqlParseError('expected an operation or fragment definition');
    }
    return { operations, fragments };
  }

  private parseVariableDefs(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const defs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (!this.eatPunct('(')) return defs;
    while (!this.eatPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName('a variable name');
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.eatPunct('=')) defaultValue = this.parseValue();
      defs.push({ name, defaultValue });
      const token = this.peek();
      if (token.kind === 'eof') throw new GqlParseError('unterminated variable definitions');
    }
    return defs;
  }

  private parseType(): void {
    if (this.eatPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type name');
    }
    this.eatPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.eatPunct('}')) {
      const token = this.peek();
      if (token.kind === 'eof') throw new GqlParseError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value !== 'on') {
        const name = this.next().value;
        return { kind: 'fragmentSpread', name, directives: this.parseDirectives() };
      }
      let typeCondition: string | null = null;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName('a type name');
      }
      const directives = this.parseDirectives();
      return { kind: 'inlineFragment', typeCondition, directives, selectionSet: this.parseSelectionSet() };
    }
    let name = this.expectName('a field name');
    let alias: string | null = null;
    if (this.eatPunct(':')) {
      alias = name;
      name = this.expectName('a field name');
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    const peeked = this.peek();
    const selectionSet = peeked.kind === 'punct' && peeked.value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }

  private parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    if (!this.eatPunct('(')) return args;
    while (!this.eatPunct(')')) {
      const name = this.expectName('an argument name');
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
      const token = this.peek();
      if (token.kind === 'eof') throw new GqlParseError('unterminated arguments');
    }
    return args;
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.eatPunct('@')) {
      const name = this.expectName('a directive name');
      directives.push({ name, args: this.parseArguments() });
    }
    return directives;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName('a variable name') };
    }
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.eatPunct(']')) {
        values.push(this.parseValue());
        if (this.peek().kind === 'eof') throw new GqlParseError('unterminated list value');
      }
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.eatPunct('}')) {
        const name = this.expectName('an input field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
        if (this.peek().kind === 'eof') throw new GqlParseError('unterminated input object');
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new GqlParseError('expected a value');
  }
}

// ---------------------------------------------------------------------------------------------
// resolved values
// ---------------------------------------------------------------------------------------------

type NodeValue =
  | { t: 'Query' }
  | { t: 'Mutation' }
  | { t: 'Repository'; repo: Repo }
  | { t: 'Issue'; repo: Repo; issue: Issue }
  | { t: 'PullRequest'; repo: Repo; pull: Pull }
  | { t: 'User'; login: string }
  | { t: 'Ref'; repo: Repo; name: string; oid: string }
  | { t: 'GitObject'; repo: Repo; oid: string }
  | { t: 'Connection'; typeName: string; edgeTypeName: string; nodes: NodeValue[]; cursors: string[]; total: number; hasNext: boolean; hasPrev: boolean; startCursor: string | null; endCursor: string | null }
  | { t: 'PageInfo'; hasNext: boolean; hasPrev: boolean; startCursor: string | null; endCursor: string | null }
  | { t: 'Edge'; typeName: string; node: NodeValue; cursor: string }
  | { t: 'Comment'; repo: Repo; number: number; comment: Comment }
  | { t: 'File'; path: string; additions: number; deletions: number; changes: number }
  | { t: 'Label'; label: Label }
  | { t: 'Payload'; typeName: string; fields: Record<string, unknown> }
  | { t: 'IntrospectionType'; name: string }
  | { t: 'IntrospectionField'; name: string }
  | { t: 'IntrospectionEnumValue'; name: string }
  | { t: 'Schema' };

function typeNameOf(node: NodeValue): string {
  switch (node.t) {
    case 'Query':
      return 'Query';
    case 'Mutation':
      return 'Mutation';
    case 'Repository':
      return 'Repository';
    case 'Issue':
      return 'Issue';
    case 'PullRequest':
      return 'PullRequest';
    case 'User':
      return 'User';
    case 'Ref':
      return 'Ref';
    case 'GitObject': {
      const object = node.repo.objects.get(node.oid);
      if (object?.type === 'commit') return 'Commit';
      if (object?.type === 'tree') return 'Tree';
      if (object?.type === 'blob') return 'Blob';
      if (object?.type === 'tag') return 'Tag';
      return 'GitObject';
    }
    case 'Connection':
      return node.typeName;
    case 'PageInfo':
      return 'PageInfo';
    case 'Edge':
      return node.typeName;
    case 'Comment':
      return 'IssueComment';
    case 'File':
      return 'ChangedFile';
    case 'Label':
      return 'Label';
    case 'Payload':
      return node.typeName;
    case 'IntrospectionType':
      return '__Type';
    case 'IntrospectionField':
      return '__Field';
    case 'IntrospectionEnumValue':
      return '__EnumValue';
    case 'Schema':
      return '__Schema';
  }
}

interface GqlErrorEntry {
  message: string;
  path: Array<string | number>;
}

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  varDefs: Array<{ name: string; defaultValue: ValueNode | null }>;
  fragments: Map<string, FragmentNode>;
  errors: GqlErrorEntry[];
}

// ---------------------------------------------------------------------------------------------
// global ids and cursors
// ---------------------------------------------------------------------------------------------

function globalId(type: string, payload: string): string {
  return Buffer.from(`${type}:${payload}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { type: string; payload: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { type: text.slice(0, colon), payload: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoByDatabaseId(store: Store, databaseId: number): Repo | null {
  for (const repo of store.repos.values()) {
    if (repo.databaseId === databaseId) return repo;
  }
  return null;
}

function encodeCursor(index: number): string {
  return Buffer.from(`idx:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^idx:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/** Slice an ordered list into a connection page: `after` is an index cursor, `first` a count. */
function paginate<T>(all: readonly T[], first: unknown, after: unknown): { page: T[]; startIndex: number; total: number; hasNext: boolean; hasPrev: boolean } {
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    const idx = decodeCursor(after);
    if (idx !== null) start = idx + 1;
  }
  const count = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, Math.floor(first)) : 30;
  const page = all.slice(start, start + count);
  return { page, startIndex: start, total: all.length, hasNext: start + page.length < all.length, hasPrev: start > 0 };
}

function connectionOf(typeName: string, edgeTypeName: string, nodes: NodeValue[], page: { startIndex: number; total: number; hasNext: boolean; hasPrev: boolean }): NodeValue {
  const cursors = nodes.map((_, i) => encodeCursor(page.startIndex + i));
  return {
    t: 'Connection',
    typeName,
    edgeTypeName,
    nodes,
    cursors,
    total: page.total,
    hasNext: page.hasNext,
    hasPrev: page.hasPrev,
    startCursor: cursors.length > 0 ? cursors[0] : null,
    endCursor: cursors.length > 0 ? cursors[cursors.length - 1] : null,
  };
}

// ---------------------------------------------------------------------------------------------
// values and arguments
// ---------------------------------------------------------------------------------------------

function valueFromAst(node: ValueNode, ctx: ExecCtx): unknown {
  switch (node.kind) {
    case 'variable': {
      if (node.name in ctx.variables) return ctx.variables[node.name];
      const def = ctx.varDefs.find((d) => d.name === node.name);
      if (def?.defaultValue != null) return valueFromAst(def.defaultValue, ctx);
      return undefined;
    }
    case 'int':
      return Number.parseInt(node.value, 10);
    case 'float':
      return Number.parseFloat(node.value);
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueFromAst(v, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromAst(field.value, ctx);
      return out;
    }
  }
}

function argValues(field: { args: ArgumentNode[] }, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) {
    const value = valueFromAst(arg.value, ctx);
    if (value !== undefined) out[arg.name] = value;
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/** Whether a field/fragment survives its @skip/@include directives. */
function directivesAllow(directives: readonly DirectiveNode[], ctx: ExecCtx): boolean {
  for (const directive of directives) {
    const args = argValues(directive, ctx);
    if (directive.name === 'skip' && args.if === true) return false;
    if (directive.name === 'include' && args.if === false) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// introspection tables
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'comments', 'labels'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'url', 'comments'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'description', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'createdAt', 'updatedAt', 'isPrivate'],
  User: ['id', 'login', 'name', 'url'],
  Ref: ['name', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const TYPE_KINDS: Record<string, string> = {
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  Repository: 'OBJECT',
  User: 'OBJECT',
  Ref: 'OBJECT',
  PageInfo: 'OBJECT',
  IssueConnection: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  IssueComment: 'OBJECT',
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  SearchType: 'ENUM',
  String: 'SCALAR',
  Int: 'SCALAR',
  Boolean: 'SCALAR',
  ID: 'SCALAR',
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
};

// ---------------------------------------------------------------------------------------------
// field resolution
// ---------------------------------------------------------------------------------------------

function issueStateOf(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateOf(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueConnection(repo: Repo, args: Record<string, unknown>): NodeValue {
  let list = [...repo.issues.values()];
  const states = asStringList(args.states);
  if (states.length > 0) {
    list = list.filter((issue) => states.includes(issueStateOf(issue)));
  }
  const orderBy = asRecord(args.orderBy);
  const direction = orderBy !== null ? asString(orderBy.direction) : null;
  const ascending = direction === 'ASC';
  list.sort((a, b) => (ascending ? a.number - b.number : b.number - a.number));
  const page = paginate(list, args.first, args.after);
  const nodes: NodeValue[] = page.page.map((issue) => ({ t: 'Issue', repo, issue }));
  return connectionOf('IssueConnection', 'IssueEdge', nodes, page);
}

function pullConnection(repo: Repo, args: Record<string, unknown>): NodeValue {
  let list = [...repo.pulls.values()];
  const states = asStringList(args.states);
  if (states.length > 0) {
    list = list.filter((pull) => states.includes(pullStateOf(pull)));
  }
  const orderBy = asRecord(args.orderBy);
  const direction = orderBy !== null ? asString(orderBy.direction) : null;
  const ascending = direction === 'ASC';
  list.sort((a, b) => (ascending ? a.number - b.number : b.number - a.number));
  const page = paginate(list, args.first, args.after);
  const nodes: NodeValue[] = page.page.map((pull) => ({ t: 'PullRequest', repo, pull }));
  return connectionOf('PullRequestConnection', 'PullRequestEdge', nodes, page);
}

function commentConnection(repo: Repo, number: number, args: Record<string, unknown>): NodeValue {
  const all = repo.comments.get(number) ?? [];
  const page = paginate(all, args.first, args.after);
  const nodes: NodeValue[] = page.page.map((comment) => ({ t: 'Comment', repo, number, comment }));
  return connectionOf('IssueCommentConnection', 'IssueCommentEdge', nodes, page);
}

function fileConnection(repo: Repo, pull: Pull, args: Record<string, unknown>): NodeValue {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseObject = repo.objects.get(baseTip);
  const headObject = repo.objects.get(headTip);
  if (baseObject?.type !== 'commit' || headObject?.type !== 'commit') {
    return connectionOf('PullRequestChangedFileConnection', 'PullRequestChangedFileEdge', [], { startIndex: 0, total: 0, hasNext: false, hasPrev: false });
  }
  const files = diffTrees(repo, parseCommit(baseObject.data).tree, parseCommit(headObject.data).tree);
  const page = paginate(files, args.first, args.after);
  const nodes: NodeValue[] = page.page.map((file) => ({ t: 'File', path: file.filename, additions: file.additions, deletions: file.deletions, changes: file.changes }));
  return connectionOf('PullRequestChangedFileConnection', 'PullRequestChangedFileEdge', nodes, page);
}

function nodeById(store: Store, id: string): NodeValue | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.type === 'Repository') {
    const repo = repoByDatabaseId(store, Number(decoded.payload));
    return repo === null ? null : { t: 'Repository', repo };
  }
  if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
    const [db, num] = decoded.payload.split(':');
    const repo = repoByDatabaseId(store, Number(db));
    if (repo === null) return null;
    const number = Number(num);
    if (decoded.type === 'Issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : { t: 'Issue', repo, issue };
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : { t: 'PullRequest', repo, pull };
  }
  if (decoded.type === 'User') {
    return { t: 'User', login: decoded.payload };
  }
  return null;
}

function resolveField(node: NodeValue, fieldName: string, args: Record<string, unknown>, ctx: ExecCtx, path: Array<string | number>): unknown {
  const store = ctx.store;
  switch (node.t) {
    case 'Query': {
      if (fieldName === 'viewer') return { t: 'User', login: viewerLoginOf(store) } satisfies NodeValue;
      if (fieldName === 'repository') {
        const owner = asString(args.owner);
        const name = asString(args.name);
        if (owner === null || name === null) return null;
        const repo = findRepo(store, owner, name);
        return repo === null ? null : ({ t: 'Repository', repo } satisfies NodeValue);
      }
      if (fieldName === 'node') {
        const id = asString(args.id);
        if (id === null) return null;
        return nodeById(store, id);
      }
      if (fieldName === '__type') {
        const name = asString(args.name);
        if (name === null) return null;
        if (TYPE_KINDS[name] === undefined && TYPE_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
        return { t: 'IntrospectionType', name } satisfies NodeValue;
      }
      if (fieldName === '__schema') return { t: 'Schema' } satisfies NodeValue;
      return undefined;
    }
    case 'Mutation': {
      if (fieldName === 'createIssue') {
        const input = asRecord(args.input);
        const repo = input === null ? null : repoFromGlobalId(store, asString(input.repositoryId));
        const title = input === null ? null : asString(input.title);
        if (repo === null || title === null) return null;
        const result = createIssueRecord(store, repo, title, asString(input.body) ?? '', []);
        if ('error' in result) return null;
        return { t: 'Payload', typeName: 'CreateIssuePayload', fields: { issue: { t: 'Issue', repo, issue: result.issue } satisfies NodeValue, clientMutationId: input.clientMutationId ?? null } } satisfies NodeValue;
      }
      if (fieldName === 'closeIssue') {
        const input = asRecord(args.input);
        const found = input === null ? null : issueFromGlobalId(store, asString(input.issueId));
        if (found === null) return null;
        found.issue.state = 'closed';
        found.issue.updatedAt = store.nowIso;
        touch(found.repo);
        return { t: 'Payload', typeName: 'CloseIssuePayload', fields: { issue: { t: 'Issue', repo: found.repo, issue: found.issue } satisfies NodeValue, clientMutationId: input.clientMutationId ?? null } } satisfies NodeValue;
      }
      if (fieldName === 'createPullRequest') {
        const input = asRecord(args.input);
        const repo = input === null ? null : repoFromGlobalId(store, asString(input.repositoryId));
        const title = input === null ? null : asString(input.title);
        const head = input === null ? null : asString(input.headRefName);
        const base = input === null ? null : asString(input.baseRefName);
        if (repo === null || title === null || head === null || base === null) return null;
        const result = createPullRecord(store, repo, title, asString(input.body) ?? '', head, base);
        if ('error' in result) return null;
        return { t: 'Payload', typeName: 'CreatePullRequestPayload', fields: { pullRequest: { t: 'PullRequest', repo, pull: result.pull } satisfies NodeValue, clientMutationId: input.clientMutationId ?? null } } satisfies NodeValue;
      }
      if (fieldName === 'mergePullRequest') {
        const input = asRecord(args.input);
        const found = input === null ? null : pullFromGlobalId(store, asString(input.pullRequestId));
        if (found === null) return null;
        const result = mergePullRecord(store, found.repo, found.pull);
        if ('conflict' in result || 'error' in result) {
          ctx.errors.push({ message: 'conflict' in result ? 'merge conflict: the pull request cannot be merged cleanly' : result.error, path: [...path] });
          return null;
        }
        return { t: 'Payload', typeName: 'MergePullRequestPayload', fields: { pullRequest: { t: 'PullRequest', repo: found.repo, pull: found.pull } satisfies NodeValue, clientMutationId: input.clientMutationId ?? null } } satisfies NodeValue;
      }
      if (fieldName === 'addComment') {
        const input = asRecord(args.input);
        const body = input === null ? null : asString(input.body);
        const subjectId = input === null ? null : asString(input.subjectId);
        if (body === null || subjectId === null) return null;
        const subject = subjectFromGlobalId(store, subjectId);
        if (subject === null) return null;
        const comment = addCommentRecord(store, subject.repo, subject.number, body);
        const edge: NodeValue = { t: 'Edge', typeName: 'IssueCommentEdge', node: { t: 'Comment', repo: subject.repo, number: subject.number, comment }, cursor: encodeCursor(0) };
        return { t: 'Payload', typeName: 'AddCommentPayload', fields: { commentEdge: edge, clientMutationId: input.clientMutationId ?? null } } satisfies NodeValue;
      }
      return undefined;
    }
    case 'Repository': {
      const repo = node.repo;
      const viewer = viewerLoginOf(store);
      switch (fieldName) {
        case 'id':
          return globalId('Repository', String(repo.databaseId));
        case 'databaseId':
          return repo.databaseId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${viewer}/${repo.name}`;
        case 'description':
          return repo.description;
        case 'owner':
          return { t: 'User', login: viewer } satisfies NodeValue;
        case 'defaultBranchRef':
          return { t: 'Ref', repo, name: repo.defaultBranch, oid: repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '' } satisfies NodeValue;
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'isPrivate':
          return repo.isPrivate;
        case 'url':
          return `https://github.com/${viewer}/${repo.name}`;
        case 'createdAt':
          return repo.createdAt;
        case 'updatedAt':
          return repo.updatedAt;
        case 'issue': {
          const number = args.number;
          if (typeof number !== 'number') return null;
          const issue = repo.issues.get(number);
          return issue === undefined ? null : ({ t: 'Issue', repo, issue } satisfies NodeValue);
        }
        case 'issues':
          return issueConnection(repo, args);
        case 'pullRequest': {
          const number = args.number;
          if (typeof number !== 'number') return null;
          const pull = repo.pulls.get(number);
          return pull === undefined ? null : ({ t: 'PullRequest', repo, pull } satisfies NodeValue);
        }
        case 'pullRequests':
          return pullConnection(repo, args);
        default:
          return undefined;
      }
    }
    case 'Issue': {
      const { repo, issue } = node;
      const viewer = viewerLoginOf(store);
      switch (fieldName) {
        case 'id':
          return globalId('Issue', `${repo.databaseId}:${issue.number}`);
        case 'databaseId':
          return issue.id;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issueStateOf(issue);
        case 'author':
          return { t: 'User', login: issue.author } satisfies NodeValue;
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'closedAt':
          return issue.state === 'closed' ? issue.updatedAt : null;
        case 'url':
          return `https://github.com/${viewer}/${repo.name}/issues/${issue.number}`;
        case 'comments':
          return commentConnection(repo, issue.number, args);
        case 'labels': {
          const labels = issue.labels
            .map((name) => repo.labels.get(name.toLowerCase()))
            .filter((l): l is Label => l !== undefined)
            .map((label) => ({ t: 'Label', label }) satisfies NodeValue);
          const page = paginate(labels, args.first, args.after);
          return connectionOf('LabelConnection', 'LabelEdge', page.page, page);
        }
        default:
          return undefined;
      }
    }
    case 'PullRequest': {
      const { repo, pull } = node;
      const viewer = viewerLoginOf(store);
      switch (fieldName) {
        case 'id':
          return globalId('PullRequest', `${repo.databaseId}:${pull.number}`);
        case 'databaseId':
          return pull.id;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullStateOf(pull);
        case 'merged':
          return pull.merged;
        case 'mergedAt':
          return pull.mergedAt;
        case 'mergeable': {
          if (pull.merged) return 'UNKNOWN';
          const mergeable = computeMergeable(repo, pull);
          return mergeable === null ? 'UNKNOWN' : mergeable ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'headRef':
          return { t: 'Ref', repo, name: pull.headRef, oid: repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha } satisfies NodeValue;
        case 'baseRef':
          return { t: 'Ref', repo, name: pull.baseRef, oid: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha } satisfies NodeValue;
        case 'files':
          return fileConnection(repo, pull, args);
        case 'author':
          return { t: 'User', login: pull.author } satisfies NodeValue;
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'url':
          return `https://github.com/${viewer}/${repo.name}/pull/${pull.number}`;
        case 'comments':
          return commentConnection(repo, pull.number, args);
        default:
          return undefined;
      }
    }
    case 'User': {
      switch (fieldName) {
        case 'login':
          return node.login;
        case 'name':
          return node.login;
        case 'id':
          return globalId('User', node.login);
        case 'url':
          return `https://github.com/${node.login}`;
        default:
          return undefined;
      }
    }
    case 'Ref': {
      switch (fieldName) {
        case 'name':
          return node.name;
        case 'target':
          if (node.oid === '' || !node.repo.objects.has(node.oid)) return null;
          return { t: 'GitObject', repo: node.repo, oid: node.oid } satisfies NodeValue;
        default:
          return undefined;
      }
    }
    case 'GitObject': {
      const object = node.repo.objects.get(node.oid);
      switch (fieldName) {
        case 'oid':
          return node.oid;
        case 'abbreviatedOid':
          return node.oid.slice(0, 7);
        case 'message':
          return object?.type === 'commit' ? parseCommit(object.data).message : null;
        default:
          return undefined;
      }
    }
    case 'Connection': {
      switch (fieldName) {
        case 'nodes':
          return node.nodes;
        case 'edges':
          return node.nodes.map((child, i) => ({ t: 'Edge', typeName: node.edgeTypeName, node: child, cursor: node.cursors[i] }) satisfies NodeValue);
        case 'pageInfo':
          return { t: 'PageInfo', hasNext: node.hasNext, hasPrev: node.hasPrev, startCursor: node.startCursor, endCursor: node.endCursor } satisfies NodeValue;
        case 'totalCount':
          return node.total;
        default:
          return undefined;
      }
    }
    case 'PageInfo': {
      switch (fieldName) {
        case 'hasNextPage':
          return node.hasNext;
        case 'hasPreviousPage':
          return node.hasPrev;
        case 'startCursor':
          return node.startCursor;
        case 'endCursor':
          return node.endCursor;
        default:
          return undefined;
      }
    }
    case 'Edge': {
      switch (fieldName) {
        case 'node':
          return node.node;
        case 'cursor':
          return node.cursor;
        default:
          return undefined;
      }
    }
    case 'Comment': {
      const { repo, number, comment } = node;
      const viewer = viewerLoginOf(store);
      switch (fieldName) {
        case 'id':
          return globalId('IssueComment', `${repo.databaseId}:${comment.id}`);
        case 'databaseId':
          return comment.id;
        case 'body':
          return comment.body;
        case 'author':
          return { t: 'User', login: comment.author } satisfies NodeValue;
        case 'createdAt':
          return comment.createdAt;
        case 'updatedAt':
          return comment.updatedAt;
        case 'url':
          return `https://github.com/${viewer}/${repo.name}/issues/${number}#issuecomment-${comment.id}`;
        default:
          return undefined;
      }
    }
    case 'File': {
      switch (fieldName) {
        case 'path':
          return node.path;
        case 'additions':
          return node.additions;
        case 'deletions':
          return node.deletions;
        case 'changes':
          return node.changes;
        default:
          return undefined;
      }
    }
    case 'Label': {
      switch (fieldName) {
        case 'id':
          return globalId('Label', String(node.label.id));
        case 'name':
          return node.label.name;
        case 'color':
          return node.label.color;
        default:
          return undefined;
      }
    }
    case 'Payload': {
      if (fieldName in node.fields) return node.fields[fieldName];
      return undefined;
    }
    case 'IntrospectionType': {
      switch (fieldName) {
        case 'name':
          return node.name;
        case 'kind':
          return TYPE_KINDS[node.name] ?? 'OBJECT';
        case 'description':
          return null;
        case 'fields': {
          const names = TYPE_FIELDS[node.name];
          if (names === undefined) return null;
          return names.map((name) => ({ t: 'IntrospectionField', name }) satisfies NodeValue);
        }
        case 'enumValues': {
          const values = ENUM_VALUES[node.name];
          if (values === undefined) return null;
          return values.map((name) => ({ t: 'IntrospectionEnumValue', name }) satisfies NodeValue);
        }
        default:
          return undefined;
      }
    }
    case 'IntrospectionField': {
      switch (fieldName) {
        case 'name':
          return node.name;
        case 'description':
          return null;
        case 'args':
          return [];
        case 'type':
          return { t: 'IntrospectionType', name: 'String' } satisfies NodeValue;
        default:
          return undefined;
      }
    }
    case 'IntrospectionEnumValue': {
      switch (fieldName) {
        case 'name':
          return node.name;
        case 'description':
          return null;
        default:
          return undefined;
      }
    }
    case 'Schema': {
      switch (fieldName) {
        case 'queryType':
          return { t: 'IntrospectionType', name: 'Query' } satisfies NodeValue;
        case 'mutationType':
          return { t: 'IntrospectionType', name: 'Mutation' } satisfies NodeValue;
        case 'description':
          return null;
        default:
          return undefined;
      }
    }
  }
}

function repoFromGlobalId(store: Store, id: string | null): Repo | null {
  if (id === null) return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'Repository') return null;
  return repoByDatabaseId(store, Number(decoded.payload));
}

function issueFromGlobalId(store: Store, id: string | null): { repo: Repo; issue: Issue } | null {
  if (id === null) return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'Issue') return null;
  const [db, num] = decoded.payload.split(':');
  const repo = repoByDatabaseId(store, Number(db));
  if (repo === null) return null;
  const issue = repo.issues.get(Number(num));
  return issue === undefined ? null : { repo, issue };
}

function pullFromGlobalId(store: Store, id: string | null): { repo: Repo; pull: Pull } | null {
  if (id === null) return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'PullRequest') return null;
  const [db, num] = decoded.payload.split(':');
  const repo = repoByDatabaseId(store, Number(db));
  if (repo === null) return null;
  const pull = repo.pulls.get(Number(num));
  return pull === undefined ? null : { repo, pull };
}

function subjectFromGlobalId(store: Store, id: string): { repo: Repo; number: number } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.type === 'Issue') {
    const found = issueFromGlobalId(store, id);
    return found === null ? null : { repo: found.repo, number: found.issue.number };
  }
  if (decoded.type === 'PullRequest') {
    const found = pullFromGlobalId(store, id);
    return found === null ? null : { repo: found.repo, number: found.pull.number };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

function isNodeValue(value: unknown): value is NodeValue {
  return typeof value === 'object' && value !== null && 't' in (value as Record<string, unknown>) && typeof (value as Record<string, unknown>).t === 'string';
}

function executeSelectionSet(node: NodeValue, selections: readonly SelectionNode[], ctx: ExecCtx, path: Array<string | number>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      if (!directivesAllow(selection.directives, ctx)) continue;
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".`, path: [...path] });
        continue;
      }
      if (fragment.typeCondition !== typeNameOf(node)) continue;
      Object.assign(out, executeSelectionSet(node, fragment.selectionSet, ctx, path));
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (!directivesAllow(selection.directives, ctx)) continue;
      if (selection.typeCondition !== null && selection.typeCondition !== typeNameOf(node)) continue;
      Object.assign(out, executeSelectionSet(node, selection.selectionSet, ctx, path));
      continue;
    }
    if (!directivesAllow(selection.directives, ctx)) continue;
    const key = selection.alias ?? selection.name;
    const fieldPath = [...path, key];
    if (selection.name === '__typename') {
      out[key] = typeNameOf(node);
      continue;
    }
    const args = argValues(selection, ctx);
    const resolved = resolveField(node, selection.name, args, ctx, fieldPath);
    if (resolved === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeNameOf(node)}".`, path: fieldPath });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(resolved, selection.selectionSet, ctx, fieldPath);
  }
  return out;
}

function completeValue(value: unknown, selectionSet: SelectionNode[] | null, ctx: ExecCtx, path: Array<string | number>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, i) => completeValue(item, selectionSet, ctx, [...path, i]));
  }
  if (isNodeValue(value)) {
    if (selectionSet === null) return {};
    return executeSelectionSet(value, selectionSet, ctx, path);
  }
  return value;
}

interface OperationInput {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function executeOperation(store: Store, input: OperationInput): { data: unknown; errors?: GqlErrorEntry[] } {
  const query = typeof input.query === 'string' ? input.query : '';
  const variables = asRecord(input.variables) ?? {};
  const operationName = typeof input.operationName === 'string' ? input.operationName : null;
  let document: DocumentNode;
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'syntax error', path: [] }] };
  }
  if (document.operations.length === 0) {
    return { data: null, errors: [{ message: 'no operation in the document', path: [] }] };
  }
  let operation = document.operations[0];
  if (operationName !== null) {
    const named = document.operations.find((op) => op.name === operationName);
    if (named === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".`, path: [] }] };
    }
    operation = named;
  }
  const ctx: ExecCtx = { store, variables, varDefs: operation.variableDefs, fragments: document.fragments, errors: [] };
  const root: NodeValue = operation.operation === 'mutation' ? { t: 'Mutation' } : { t: 'Query' };
  const data = executeSelectionSet(root, operation.selectionSet, ctx, []);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

// ---------------------------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------------------------

/**
 * Handle a GraphQL request. Returns true when the path was /api/graphql (handled or 404);
 * false when the path is not a GraphQL path at all and the router should keep looking.
 */
export function handleGraphql(ctx: Ctx, req: IncomingMessage, res: ServerResponse, body: Buffer): boolean {
  if (ctx.segments.length !== 2 || ctx.segments[0] !== 'api' || ctx.segments[1] !== 'graphql') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendError(res, 404, 'Not Found');
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
    sendJson(res, 400, { errors: [{ message: 'request body is not valid JSON' }] });
    return true;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      const input = asRecord(entry);
      if (input === null) return { data: null, errors: [{ message: 'a batched entry must be an object', path: [] }] };
      return executeOperation(ctx.store, input);
    });
    sendJson(res, 200, results);
    return true;
  }
  const input = asRecord(parsed);
  if (input === null) {
    sendJson(res, 400, { errors: [{ message: 'request body must be a JSON object or array' }] });
    return true;
  }
  sendJson(res, 200, executeOperation(ctx.store, input));
  return true;
}
