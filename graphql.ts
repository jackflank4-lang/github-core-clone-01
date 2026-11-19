// graphql.ts — a minimal GraphQL parser + executor for the forge's surface.
// Covers the documents the suite sends (queries, mutations, __type probes,
// node(id:), batched operations). Written from scratch for the
// github-core-clone-01 forge (Node 22, stdlib only).

import { Repo, Store, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME } from './store.ts';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string };

function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string): boolean => /[_0-9A-Za-z]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!$=@[]'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'u' && j + 5 < src.length) {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += e;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      if (j >= src.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      const num = Number(src.slice(i, j));
      tokens.push(isFloat ? { kind: 'float', value: num } : { kind: 'int', value: num });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

export interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  selection?: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  selection: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface OperationNode {
  kind: 'query' | 'mutation';
  name?: string;
  variables: Record<string, { defaultValue?: ValueNode }>;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (t === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return t;
  }

  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${JSON.stringify(v)}, got ${JSON.stringify(t)}`);
  }

  private skipPunct(v: string): boolean {
    const t = this.peek();
    if (t?.kind === 'punct' && t.value === v) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(t)}`);
    return t.value;
  }

  parseDocument(): OperationNode[] {
    const ops: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    const t = this.peek();
    if (t?.kind === 'punct' && t.value === '{') {
      return { kind: 'query', variables: {}, selection: this.parseSelectionSet() };
    }
    if (t?.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      kind = t.value;
      this.next();
    } else {
      throw new Error(`expected an operation, got ${JSON.stringify(t)}`);
    }
    let name: string | undefined;
    const maybeName = this.peek();
    if (maybeName?.kind === 'name') {
      name = this.next().value as string;
    }
    const variables: Record<string, { defaultValue?: ValueNode }> = {};
    if (this.skipPunct('(')) {
      while (!this.skipPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        const def: { defaultValue?: ValueNode } = {};
        if (this.skipPunct('=')) def.defaultValue = this.parseValue();
        variables[varName] = def;
      }
    }
    // Directives on the operation (ignored).
    while (this.skipPunct('@')) {
      this.expectName();
      if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseArguments();
    }
    return { kind, name, variables, selection: this.parseSelectionSet() };
  }

  private parseType(): void {
    const t = this.peek();
    if (t?.kind === 'punct' && t.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      out.push(this.parseSelection());
    }
    return out;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t?.kind === 'punct' && t.value === '...') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selection: this.parseSelectionSet() };
      }
      throw new Error('named fragment spreads are not supported');
    }
    // Field: [alias ':'] name [(args)] [@directives] [selection]
    let name = this.expectName();
    let alias: string | undefined;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    let args: Record<string, ValueNode> = {};
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      args = this.parseArguments();
    }
    while (this.skipPunct('@')) {
      this.expectName();
      if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseArguments();
    }
    let selection: SelectionNode[] | undefined;
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selection };
  }

  private parseArguments(): Record<string, ValueNode> {
    this.expectPunct('(');
    const out: Record<string, ValueNode> = {};
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      out[name] = this.parseValue();
    }
    return out;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = resolveValue(v, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema metadata (for __type probes)
// ---------------------------------------------------------------------------

const SCHEMA_TYPES: Record<string, { kind: string; fields?: string[]; enumValues?: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'avatarUrl'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt'],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'author', 'url'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergeable', 'merged', 'mergedAt', 'files', 'createdAt', 'updatedAt', 'author'],
  },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestFileConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo'] },
  PullRequestFile: { kind: 'OBJECT', fields: ['path'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'] },
  Ref: { kind: 'OBJECT', fields: ['name'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'DISCUSSION'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface GqlNode {
  __gqlType: string;
  [key: string]: unknown;
}

function nodeOf(type: string, value: Record<string, unknown>): GqlNode {
  return { __gqlType: type, ...value };
}

function cursorFor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64url');
}

function cursorToNumber(cursor: string | undefined): number | undefined {
  if (cursor === undefined || cursor === null) return undefined;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    if (m) return parseInt(m[1], 10);
  } catch {
    return undefined;
  }
  return undefined;
}

class Executor {
  private errors: Array<{ message: string }> = [];
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  execute(op: OperationNode, variables: Record<string, unknown>): { data: Record<string, unknown>; errors: Array<{ message: string }> } {
    const vars: Record<string, unknown> = { ...variables };
    for (const [name, def] of Object.entries(op.variables)) {
      if (vars[name] === undefined && def.defaultValue !== undefined) {
        vars[name] = resolveValue(def.defaultValue, vars);
      }
    }
    const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
    const root = nodeOf(rootType, {});
    const data = this.executeSelection(root, op.selection, vars);
    return { data, errors: this.errors };
  }

  private executeSelection(parent: GqlNode, selection: SelectionNode[], vars: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const sel of selection) {
      if (sel.kind === 'fragment') {
        if (sel.typeCondition === parent.__gqlType) {
          Object.assign(out, this.executeSelection(parent, sel.selection, vars));
        }
        continue;
      }
      const responseKey = sel.alias ?? sel.name;
      const args: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(sel.args)) args[k] = resolveValue(v, vars);
      const value = this.resolveField(parent, sel.name, args);
      if (value === undefined) {
        // Unknown field: record the error, value is null.
        this.errors.push({ message: `Cannot query field "${sel.name}" on type "${parent.__gqlType}".` });
        out[responseKey] = null;
        continue;
      }
      if (value === null || sel.selection === undefined) {
        out[responseKey] = value;
        continue;
      }
      if (Array.isArray(value)) {
        out[responseKey] = value.map((item) => {
          if (item !== null && typeof item === 'object' && '__gqlType' in item) {
            return this.executeSelection(item as GqlNode, sel.selection as SelectionNode[], vars);
          }
          return item;
        });
        continue;
      }
      if (typeof value === 'object' && '__gqlType' in value) {
        out[responseKey] = this.executeSelection(value as GqlNode, sel.selection as SelectionNode[], vars);
        continue;
      }
      out[responseKey] = value;
    }
    return out;
  }

  /** Resolve one field; returns undefined when the field does not exist on the type. */
  private resolveField(parent: GqlNode, field: string, args: Record<string, unknown>): unknown {
    const type = parent.__gqlType;
    switch (type) {
      case 'Query':
        return this.resolveQuery(parent, field, args);
      case 'Mutation':
        return this.resolveMutation(parent, field, args);
      case 'User':
        if (field === 'login') return parent.login;
        if (field === 'id') return parent.id;
        if (field === 'name') return parent.name;
        if (field === 'email') return parent.email;
        if (field === 'avatarUrl') return '';
        return undefined;
      case 'Repository':
        return this.resolveRepository(parent, field, args);
      case 'Issue':
        if (field === 'id') return parent.id;
        if (field === 'number') return parent.number;
        if (field === 'title') return parent.title;
        if (field === 'state') return parent.state;
        if (field === 'body') return parent.body;
        if (field === 'createdAt' || field === 'updatedAt') return '2025-01-01T00:00:00Z';
        if (field === 'closedAt') return parent.state === 'CLOSED' ? '2025-01-01T00:00:00Z' : null;
        if (field === 'author') return nodeOf('User', { login: VIEWER_LOGIN, id: String(VIEWER_ID), name: VIEWER_NAME, email: VIEWER_EMAIL });
        if (field === 'url') return parent.url;
        return undefined;
      case 'PullRequest':
        return this.resolvePullRequest(parent, field, args);
      case 'IssueComment':
        if (field === 'id') return parent.id;
        if (field === 'body') return parent.body;
        if (field === 'author') return nodeOf('User', { login: VIEWER_LOGIN, id: String(VIEWER_ID), name: VIEWER_NAME, email: VIEWER_EMAIL });
        if (field === 'createdAt') return '2025-01-01T00:00:00Z';
        return undefined;
      case 'IssueConnection':
      case 'PullRequestConnection':
      case 'PullRequestFileConnection':
        if (field === 'nodes') return parent.nodes;
        if (field === 'pageInfo') return parent.pageInfo;
        if (field === 'totalCount') return parent.totalCount;
        return undefined;
      case 'PageInfo':
        if (field === 'hasNextPage') return parent.hasNextPage;
        if (field === 'endCursor') return parent.endCursor;
        if (field === 'hasPreviousPage') return false;
        if (field === 'startCursor') return parent.startCursor ?? null;
        return undefined;
      case 'Ref':
        if (field === 'name') return parent.name;
        return undefined;
      case 'PullRequestFile':
        if (field === 'path') return parent.path;
        return undefined;
      case '__Type':
        return this.resolveType(parent, field, args);
      case '__Field':
        if (field === 'name') return parent.name;
        if (field === 'type') return parent.type;
        if (field === 'description') return null;
        if (field === 'args') return [];
        return undefined;
      case '__EnumValue':
        if (field === 'name') return parent.name;
        if (field === 'description') return null;
        return undefined;
      case '__TypeRef':
        if (field === 'name') return parent.name;
        if (field === 'kind') return parent.kind;
        if (field === 'ofType') return parent.ofType ?? null;
        return undefined;
      case 'CreateIssuePayload':
      case 'CloseIssuePayload':
        if (field === 'issue') return parent.issue;
        return undefined;
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload':
        if (field === 'pullRequest') return parent.pullRequest;
        return undefined;
      case 'AddCommentPayload':
        if (field === 'commentEdge') return parent.commentEdge;
        return undefined;
      case 'IssueEdge':
      case 'IssueCommentEdge':
        if (field === 'node') return parent.node;
        if (field === 'cursor') return parent.cursor;
        return undefined;
      default:
        return undefined;
    }
  }

  private resolveQuery(_parent: GqlNode, field: string, args: Record<string, unknown>): unknown {
    if (field === 'viewer') {
      return nodeOf('User', { login: VIEWER_LOGIN, id: String(VIEWER_ID), name: VIEWER_NAME, email: VIEWER_EMAIL });
    }
    if (field === 'repository') {
      const repo = this.store.getRepo(String(args.owner), String(args.name));
      if (repo === undefined) return null;
      return repoNode(this.store, repo);
    }
    if (field === 'node') {
      const decoded = this.store.decodeGlobalId(String(args.id));
      if (decoded === undefined) return null;
      const repo = this.store.repoById(decoded.repoId);
      if (repo === undefined) return null;
      if (decoded.kind === 'Repository') return repoNode(this.store, repo);
      if (decoded.kind === 'Issue') {
        const issue = repo.findIssue(decoded.number);
        if (issue === undefined) return null;
        return issueNode(this.store, repo, issue);
      }
      if (decoded.kind === 'PullRequest') {
        const pr = repo.findPull(decoded.number);
        if (pr === undefined) return null;
        return pullNode(this.store, repo, pr);
      }
      if (decoded.kind === 'IssueComment') {
        for (const issue of repo.issues) {
          const c = issue.comments.find((cc) => cc.id === decoded.number);
          if (c) return nodeOf('IssueComment', { id: this.store.commentGlobalId(repo, c.id), body: c.body });
        }
        return null;
      }
      return null;
    }
    if (field === '__type') {
      const meta = SCHEMA_TYPES[String(args.name)];
      if (meta === undefined) return null;
      return nodeOf('__Type', { name: String(args.name), kind: meta.kind, fields: meta.fields ?? [], enumValues: meta.enumValues ?? [] });
    }
    if (field === '__schema') {
      return nodeOf('__Schema', { types: Object.keys(SCHEMA_TYPES) });
    }
    return undefined;
  }

  private resolveMutation(_parent: GqlNode, field: string, args: Record<string, unknown>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (field === 'createIssue') {
      const decoded = this.store.decodeGlobalId(String(input.repositoryId));
      if (decoded === undefined) {
        this.errors.push({ message: 'createIssue: unknown repositoryId' });
        return null;
      }
      const repo = this.store.repoById(decoded.repoId);
      if (repo === undefined) {
        this.errors.push({ message: 'createIssue: unknown repositoryId' });
        return null;
      }
      const issue = repo.createIssue(String(input.title), String(input.body ?? ''), []);
      return nodeOf('CreateIssuePayload', { issue: issueNode(this.store, repo, issue) });
    }
    if (field === 'closeIssue') {
      const decoded = this.store.decodeGlobalId(String(input.issueId));
      if (decoded === undefined) {
        this.errors.push({ message: 'closeIssue: unknown issueId' });
        return null;
      }
      const repo = this.store.repoById(decoded.repoId);
      const issue = repo?.findIssue(decoded.number);
      if (repo === undefined || issue === undefined) {
        this.errors.push({ message: 'closeIssue: unknown issueId' });
        return null;
      }
      issue.state = 'closed';
      repo.invalidateIssue(issue.number);
      return nodeOf('CloseIssuePayload', { issue: issueNode(this.store, repo, issue) });
    }
    if (field === 'createPullRequest') {
      const decoded = this.store.decodeGlobalId(String(input.repositoryId));
      if (decoded === undefined) {
        this.errors.push({ message: 'createPullRequest: unknown repositoryId' });
        return null;
      }
      const repo = this.store.repoById(decoded.repoId);
      if (repo === undefined) {
        this.errors.push({ message: 'createPullRequest: unknown repositoryId' });
        return null;
      }
      const pr = repo.createPull(String(input.title), String(input.body ?? ''), String(input.headRefName), String(input.baseRefName));
      return nodeOf('CreatePullRequestPayload', { pullRequest: pullNode(this.store, repo, pr) });
    }
    if (field === 'mergePullRequest') {
      const decoded = this.store.decodeGlobalId(String(input.pullRequestId));
      if (decoded === undefined) {
        this.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
        return null;
      }
      const repo = this.store.repoById(decoded.repoId);
      const pr = repo?.findPull(decoded.number);
      if (repo === undefined || pr === undefined) {
        this.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
        return null;
      }
      if (pr.state === 'closed') {
        this.errors.push({ message: 'mergePullRequest: pull request is already closed' });
        return null;
      }
      const result = repo.mergePullRequest(pr);
      if ('conflict' in result) {
        this.errors.push({ message: 'mergePullRequest: merge conflict' });
        return null;
      }
      return nodeOf('MergePullRequestPayload', { pullRequest: pullNode(this.store, repo, pr) });
    }
    if (field === 'addComment') {
      const decoded = this.store.decodeGlobalId(String(input.subjectId));
      if (decoded === undefined) {
        this.errors.push({ message: 'addComment: unknown subjectId' });
        return null;
      }
      const repo = this.store.repoById(decoded.repoId);
      const issue = repo?.findIssue(decoded.number);
      if (repo === undefined || issue === undefined) {
        this.errors.push({ message: 'addComment: unknown subjectId' });
        return null;
      }
      const comment = { id: repo.commentCounter, body: String(input.body ?? '') };
      repo.commentCounter += 1;
      issue.comments.push(comment);
      repo.invalidateIssue(issue.number);
      const node = nodeOf('IssueComment', { id: this.store.commentGlobalId(repo, comment.id), body: comment.body });
      return nodeOf('AddCommentPayload', { commentEdge: nodeOf('IssueCommentEdge', { node, cursor: cursorFor(comment.id) }) });
    }
    return undefined;
  }

  private resolveRepository(parent: GqlNode, field: string, args: Record<string, unknown>): unknown {
    const repo = parent.__repo as Repo;
    switch (field) {
      case 'id':
        return parent.id;
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return nodeOf('User', { login: repo.owner, id: String(repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0), name: repo.owner === VIEWER_LOGIN ? VIEWER_NAME : repo.owner, email: '' });
      case 'defaultBranchRef': {
        const head = repo.headOid();
        if (head === undefined) return null;
        return nodeOf('Ref', { name: repo.defaultBranch });
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.isPrivate;
      case 'createdAt':
      case 'updatedAt':
        return '2025-01-01T00:00:00Z';
      case 'issue': {
        const issue = repo.findIssue(Number(args.number));
        if (issue === undefined) return null;
        return issueNode(this.store, repo, issue);
      }
      case 'issues': {
        const first = args.first !== undefined ? Number(args.first) : undefined;
        const after = cursorToNumber(args.after as string | undefined);
        const states = Array.isArray(args.states) ? (args.states as string[]) : undefined;
        const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
        const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
        let list = repo.issues.filter((i) => states === undefined || states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
        list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        if (after !== undefined) {
          const idx = list.findIndex((i) => i.number === after);
          if (idx >= 0) list = list.slice(idx + 1);
        }
        const total = list.length;
        const page = first !== undefined ? list.slice(0, first) : list;
        const hasNext = first !== undefined ? total > first : false;
        const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
        return nodeOf('IssueConnection', {
          nodes: page.map((i) => issueNode(this.store, repo, i)),
          pageInfo: nodeOf('PageInfo', { hasNextPage: hasNext, endCursor, startCursor: page.length > 0 ? cursorFor(page[0].number) : null }),
          totalCount: total,
        });
      }
      case 'pullRequests': {
        const first = args.first !== undefined ? Number(args.first) : undefined;
        const list = [...repo.pulls].sort((a, b) => b.number - a.number);
        const page = first !== undefined ? list.slice(0, first) : list;
        return nodeOf('PullRequestConnection', {
          nodes: page.map((p) => pullNode(this.store, repo, p)),
          pageInfo: nodeOf('PageInfo', { hasNextPage: first !== undefined && list.length > first, endCursor: page.length > 0 ? cursorFor(page[page.length - 1].number) : null, startCursor: null }),
          totalCount: list.length,
        });
      }
      case 'pullRequest': {
        const pr = repo.findPull(Number(args.number));
        if (pr === undefined) return null;
        return pullNode(this.store, repo, pr);
      }
      default:
        return undefined;
    }
  }

  private resolvePullRequest(parent: GqlNode, field: string, args: Record<string, unknown>): unknown {
    const repo = parent.__repo as Repo;
    const pr = parent.__pr as import('./store.ts').PullRequest;
    switch (field) {
      case 'id':
        return parent.id;
      case 'number':
        return pr.number;
      case 'title':
        return pr.title;
      case 'body':
        return pr.body;
      case 'headRefName':
        return pr.headRef;
      case 'baseRefName':
        return pr.baseRef;
      case 'state':
        return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged':
        return pr.merged;
      case 'mergedAt':
        return pr.mergedAt;
      case 'mergeable':
        if (pr.state !== 'open') return 'UNKNOWN';
        return repo.prIsConflicted(pr) ? 'CONFLICTING' : 'MERGEABLE';
      case 'createdAt':
      case 'updatedAt':
        return '2025-01-01T00:00:00Z';
      case 'author':
        return nodeOf('User', { login: VIEWER_LOGIN, id: String(VIEWER_ID), name: VIEWER_NAME, email: VIEWER_EMAIL });
      case 'files': {
        const first = args.first !== undefined ? Number(args.first) : undefined;
        const baseTip = repo.getRef(`refs/heads/${pr.baseRef}`);
        const headTip = repo.getRef(`refs/heads/${pr.headRef}`);
        let diff: Array<{ path: string }> = [];
        if (baseTip !== undefined && headTip !== undefined) {
          const baseTree = repo.treeOf(baseTip);
          const headTree = repo.treeOf(headTip);
          if (baseTree !== undefined && headTree !== undefined) {
            diff = repo.diffTrees(baseTree, headTree).map((d) => ({ path: d.path }));
          }
        }
        const page = first !== undefined ? diff.slice(0, first) : diff;
        return nodeOf('PullRequestFileConnection', {
          nodes: page.map((d) => nodeOf('PullRequestFile', { path: d.path })),
          pageInfo: nodeOf('PageInfo', { hasNextPage: first !== undefined && diff.length > first, endCursor: null, startCursor: null }),
        });
      }
      default:
        return undefined;
    }
  }

  private resolveType(parent: GqlNode, field: string, _args: Record<string, unknown>): unknown {
    if (field === 'name') return parent.name;
    if (field === 'kind') return parent.kind;
    if (field === 'description') return null;
    if (field === 'fields') {
      const names = (parent.fields as string[]) ?? [];
      return names.map((n) => nodeOf('__Field', { name: n, type: nodeOf('__TypeRef', { name: 'String', kind: 'SCALAR', ofType: null }) }));
    }
    if (field === 'enumValues') {
      const names = (parent.enumValues as string[]) ?? [];
      return names.map((n) => nodeOf('__EnumValue', { name: n }));
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Node builders (attach the repo / PR for resolvers that need the store)
// ---------------------------------------------------------------------------

export function repoNode(store: Store, repo: Repo): GqlNode {
  return nodeOf('Repository', {
    id: store.repoGlobalId(repo),
    __repo: repo,
  });
}

export function issueNode(store: Store, repo: Repo, issue: import('./store.ts').Issue): GqlNode {
  return nodeOf('Issue', {
    id: store.issueGlobalId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    url: `https://github.example/${repo.owner}/${repo.name}/issues/${issue.number}`,
    __repo: repo,
  });
}

export function pullNode(store: Store, repo: Repo, pr: import('./store.ts').PullRequest): GqlNode {
  return nodeOf('PullRequest', {
    id: store.pullGlobalId(repo, pr.number),
    __repo: repo,
    __pr: pr,
  });
}

// ---------------------------------------------------------------------------
// Entry point: execute one operation (or a batch) from a parsed JSON body
// ---------------------------------------------------------------------------

export interface GraphQLOperation {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export function executeGraphQL(store: Store, op: GraphQLOperation): Record<string, unknown> {
  const query = op.query ?? '';
  let operations: OperationNode[];
  try {
    operations = new Parser(lex(query)).parseDocument();
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
  let chosen = operations[0];
  if (op.operationName !== undefined) {
    const named = operations.find((o) => o.name === op.operationName);
    if (named !== undefined) chosen = named;
  }
  if (chosen === undefined) {
    return { data: null, errors: [{ message: 'no operation in document' }] };
  }
  const executor = new Executor(store);
  const result = executor.execute(chosen, op.variables ?? {});
  const out: Record<string, unknown> = { data: result.data };
  if (result.errors.length > 0) out.errors = result.errors;
  return out;
}
