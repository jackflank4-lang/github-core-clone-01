// graphql.ts — a small hand-written GraphQL executor for the documents gh and
// github-mcp-server send (see the kit's checks-graphql.ts). It is not a general
// GraphQL server: it parses the query language subset those documents use
// (operations, variables, arguments, aliases, inline fragments, __type) and
// resolves them against the same store REST and MCP use, so a mutation made
// over GraphQL reads back over REST as the same object.
//
// Contract: POST /api/graphql, JSON {query, variables} or an array of two operation
// documents (two results, in order). Unknown field = HTTP 200 + an errors array
// naming it. Unknown repo = data.repository null, no errors. No token = exactly 401.

import { decodeGlobalId, globalId, isRecord, type Issue, type Pull, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------
// parser: the query-language subset these documents use
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'string' | 'punct' | 'spread' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!$=@[]'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  arguments: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  name: string | null;
  selections: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: Array<{ name: string; type: string; defaultValue?: ValueNode }>;
  selections: SelectionNode[];
}

export interface FragmentDefinitionNode {
  kind: 'fragmentDefinition';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

export type DefinitionNode = OperationNode | FragmentDefinitionNode;

export interface DocumentNode {
  definitions: DefinitionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private next(): Token {
    return this.tokens[this.pos++]!;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }
  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const definitions: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') definitions.push(this.parseDefinition());
    return { definitions };
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variableDefinitions: [], selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      const variableDefinitions = this.parseVariableDefinitions();
      this.parseDirectives();
      return { kind: 'operation', operation, name, variableDefinitions, selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      this.parseDirectives();
      return { kind: 'fragmentDefinition', name, typeCondition, selections: this.parseSelectionSet() };
    }
    throw new Error(`unexpected token ${token.value} at the top of a GraphQL document`);
  }

  private parseVariableDefinitions(): OperationNode['variableDefinitions'] {
    const out: OperationNode['variableDefinitions'] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        out.push(defaultValue === undefined ? { name, type } : { name, type, defaultValue });
      }
      this.next();
    }
    return out;
  }

  private parseType(): string {
    let type: string;
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      type = `[${this.parseType()}]`;
      this.expectPunct(']');
    } else {
      type = this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  private parseDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.next();
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.parseDirectives();
        return { kind: 'fragment', typeCondition, name: null, selections: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.parseDirectives();
      return { kind: 'fragment', typeCondition: null, name, selections: [] };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.parseDirectives();
    const selections = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, arguments: args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const out: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        out.push({ name, value: this.parseValue() });
      }
      this.next();
    }
    return out;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'string': return node.value;
    case 'int': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// schema: the field lists introspection reports, and the enum values
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'databaseId', 'name', 'email', 'url', 'avatarUrl'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'url', 'isPrivate', 'fork',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'createdAt', 'updatedAt', 'pushedAt',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'labels', 'milestones', 'branches', 'refs',
  ],
  Ref: ['id', 'name', 'prefix', 'target'],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'closedAt',
    'author', 'labels', 'comments', 'assignees', 'milestone', 'locked', 'reactions',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'closedAt',
    'author', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergeable', 'merged', 'mergedAt',
    'mergeCommit', 'isDraft', 'files', 'additions', 'deletions', 'changedFiles', 'commits', 'reviews',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Comment: ['id', 'databaseId', 'body', 'createdAt', 'updatedAt', 'author', 'url'],
  IssueComment: ['id', 'databaseId', 'body', 'createdAt', 'updatedAt', 'author', 'url'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'actor', 'clientMutationId'],
  Commit: ['oid', 'message', 'author', 'committer'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'MILESTONE', 'COMMIT', 'CODE', 'WIKI'];

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDefinitionNode>;
  errors: Array<{ message: string }>;
}

/** A runtime value: its GraphQL type plus the record the fields read from. */
interface RuntimeValue {
  type: string;
  value: Record<string, unknown> | null;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function repoRuntime(store: Store, repo: Repo): RuntimeValue {
  return {
    type: 'Repository',
    value: {
      __repo: repo,
      id: globalId('Repository', repo.id),
      databaseId: repo.id,
      name: repo.name,
      nameWithOwner: `${repo.owner}/${repo.name}`,
      description: repo.description,
      url: `https://github.com/${repo.owner}/${repo.name}`,
      isPrivate: repo.private,
      fork: false,
      viewerPermission: 'ADMIN',
      hasIssuesEnabled: true,
      createdAt: repo.createdAt,
      updatedAt: repo.updatedAt,
      pushedAt: repo.updatedAt,
    },
  };
}

function issueRuntime(store: Store, repo: Repo, issue: Issue): RuntimeValue {
  return {
    type: 'Issue',
    value: {
      __repo: repo,
      __issue: issue,
      id: globalId('Issue', repo.id, issue.number),
      databaseId: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issueState(issue),
      url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      closedAt: issue.state === 'closed' ? issue.updatedAt : null,
      locked: false,
    },
  };
}

function pullRuntime(store: Store, repo: Repo, pull: Pull): RuntimeValue {
  return {
    type: 'PullRequest',
    value: {
      __repo: repo,
      __pull: pull,
      id: globalId('PullRequest', repo.id, pull.number),
      databaseId: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pullState(pull),
      url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
      createdAt: pull.createdAt,
      updatedAt: pull.updatedAt,
      closedAt: pull.state === 'closed' ? pull.updatedAt : null,
      headRefName: pull.headRef,
      baseRefName: pull.baseRef,
      merged: pull.merged,
      mergedAt: pull.mergedAt,
      isDraft: false,
    },
  };
}

function cursorFor(kind: string, repoId: number, number: number): string {
  return Buffer.from(`cursor:${kind}:${repoId}:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string | null | undefined, kind: string, repoId: number): number | null {
  if (typeof cursor !== 'string' || cursor.length === 0) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length === 4 && parts[0] === 'cursor' && parts[1] === kind && Number(parts[2]) === repoId) {
      const n = Number(parts[3]);
      return Number.isInteger(n) ? n : null;
    }
  } catch {
    return null;
  }
  return null;
}

interface ConnectionResult {
  nodes: RuntimeValue[];
  edges: Array<{ node: RuntimeValue; cursor: string }>;
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  totalCount: number;
}

function paginateConnection(
  items: RuntimeValue[],
  first: number | null,
  after: string | null | undefined,
  kind: string,
  repoId: number,
): ConnectionResult {
  const afterNumber = cursorNumber(after, kind, repoId);
  let start = 0;
  if (afterNumber !== null) {
    const index = items.findIndex((item) => {
      const value = item.value as Record<string, unknown>;
      return value.number === afterNumber;
    });
    start = index < 0 ? items.length : index + 1;
  }
  const limit = first === null || first === undefined ? items.length : Math.max(0, first);
  const page = items.slice(start, start + limit);
  const edges = page.map((node) => ({
    node,
    cursor: cursorFor(kind, repoId, (node.value as Record<string, unknown>).number as number),
  }));
  return {
    nodes: page,
    edges,
    pageInfo: {
      hasNextPage: start + page.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges.length > 0 ? edges[0]!.cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1]!.cursor : null,
    },
    totalCount: items.length,
  };
}

/** Resolve one field of a runtime value. Returns null when the field is unknown. */
function resolveField(ctx: ExecContext, runtime: RuntimeValue, field: FieldNode): RuntimeValue | null {
  const store = ctx.store;
  const value = runtime.value;
  if (value === null) return null;
  const args: Record<string, unknown> = {};
  for (const arg of field.arguments) args[arg.name] = resolveValue(arg.value, ctx.variables);

  switch (runtime.type) {
    case 'Query': {
      if (field.name === 'viewer') {
        return {
          type: 'User',
          value: {
            login: store.viewerLogin(),
            id: globalId('User', store.identity.viewerId),
            databaseId: store.identity.viewerId,
            name: store.identity.viewerName,
            email: store.identity.viewerEmail,
            url: `https://github.com/${store.viewerLogin()}`,
            avatarUrl: '',
          },
        };
      }
      if (field.name === 'repository') {
        const owner = args.owner;
        const name = args.name;
        if (typeof owner !== 'string' || typeof name !== 'string') return null;
        if (!store.isViewer(owner)) return { type: 'Repository', value: null };
        const repo = store.getRepo(owner, name);
        if (repo === undefined) return { type: 'Repository', value: null };
        return repoRuntime(store, repo);
      }
      if (field.name === 'node') {
        const id = args.id;
        if (typeof id !== 'string') return { type: 'Node', value: null };
        const decoded = decodeGlobalId(id);
        if (decoded === null) return { type: 'Node', value: null };
        if (decoded.kind === 'Repository') {
          const repo = store.getRepoById(Number(decoded.parts[0]));
          if (repo === undefined) return { type: 'Node', value: null };
          return repoRuntime(store, repo);
        }
        if (decoded.kind === 'Issue') {
          const repo = store.getRepoById(Number(decoded.parts[0]));
          const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[1]));
          if (repo === undefined || issue === undefined) return { type: 'Node', value: null };
          return issueRuntime(store, repo, issue);
        }
        if (decoded.kind === 'PullRequest') {
          const repo = store.getRepoById(Number(decoded.parts[0]));
          const pull = repo?.pulls.find((p) => p.number === Number(decoded.parts[1]));
          if (repo === undefined || pull === undefined) return { type: 'Node', value: null };
          return pullRuntime(store, repo, pull);
        }
        return { type: 'Node', value: null };
      }
      if (field.name === '__type') {
        const name = args.name;
        if (typeof name !== 'string') return null;
        return { type: '__Type', value: { __typeName: name } };
      }
      if (field.name === '__schema') {
        return { type: '__Schema', value: {} };
      }
      return null;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const repoId = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
        const repo = repoId?.kind === 'Repository' ? store.getRepoById(Number(repoId.parts[0])) : undefined;
        if (repo === undefined || typeof input.title !== 'string') {
          ctx.errors.push({ message: 'createIssue: repository not found or title missing' });
          return { type: 'CreateIssuePayload', value: null };
        }
        const created = store.createIssue(repo, { title: input.title, body: typeof input.body === 'string' ? input.body : '' });
        if ('error' in created) {
          ctx.errors.push({ message: created.error });
          return { type: 'CreateIssuePayload', value: null };
        }
        return { type: 'CreateIssuePayload', value: { __issue: created, __repo: repo } };
      }
      if (field.name === 'closeIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const issueId = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
        const repo = issueId?.kind === 'Issue' ? store.getRepoById(Number(issueId.parts[0])) : undefined;
        const issue = repo?.issues.find((i) => i.number === Number(issueId?.parts[1]));
        if (repo === undefined || issue === undefined) {
          ctx.errors.push({ message: 'closeIssue: issue not found' });
          return { type: 'CloseIssuePayload', value: null };
        }
        issue.state = 'closed';
        const now = store.tick();
        issue.updatedSeq = store.currentSeq();
        issue.updatedAt = store.iso(now);
        return { type: 'CloseIssuePayload', value: { __issue: issue, __repo: repo } };
      }
      if (field.name === 'createPullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const repoId = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
        const repo = repoId?.kind === 'Repository' ? store.getRepoById(Number(repoId.parts[0])) : undefined;
        if (repo === undefined || typeof input.headRefName !== 'string' || typeof input.baseRefName !== 'string' || typeof input.title !== 'string') {
          ctx.errors.push({ message: 'createPullRequest: repository or refs missing' });
          return { type: 'CreatePullRequestPayload', value: null };
        }
        const created = store.createPull(repo, { title: input.title, body: typeof input.body === 'string' ? input.body : '', head: input.headRefName, base: input.baseRefName });
        if ('error' in created) {
          ctx.errors.push({ message: created.error });
          return { type: 'CreatePullRequestPayload', value: null };
        }
        return { type: 'CreatePullRequestPayload', value: { __pull: created, __repo: repo } };
      }
      if (field.name === 'mergePullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const pullId = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
        const repo = pullId?.kind === 'PullRequest' ? store.getRepoById(Number(pullId.parts[0])) : undefined;
        const pull = repo?.pulls.find((p) => p.number === Number(pullId?.parts[1]));
        if (repo === undefined || pull === undefined) {
          ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
          return { type: 'MergePullRequestPayload', value: null };
        }
        const result = store.mergePull(repo, pull);
        if (typeof result === 'object') {
          ctx.errors.push({ message: result.error });
          return { type: 'MergePullRequestPayload', value: null };
        }
        return { type: 'MergePullRequestPayload', value: { __pull: pull, __repo: repo } };
      }
      if (field.name === 'addComment') {
        const input = isRecord(args.input) ? args.input : {};
        const subjectId = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
        const repo = subjectId !== null ? store.getRepoById(Number(subjectId.parts[0])) : undefined;
        if (repo === undefined || typeof input.body !== 'string') {
          ctx.errors.push({ message: 'addComment: subject not found or body missing' });
          return { type: 'AddCommentPayload', value: null };
        }
        if (subjectId?.kind === 'Issue') {
          const issue = repo.issues.find((i) => i.number === Number(subjectId.parts[1]));
          if (issue === undefined) {
            ctx.errors.push({ message: 'addComment: issue not found' });
            return { type: 'AddCommentPayload', value: null };
          }
          const comment = store.addComment(repo, issue, input.body);
          return {
            type: 'AddCommentPayload',
            value: {
              __comment: { id: globalId('IssueComment', repo.id, issue.number, comment.id), body: comment.body, createdAt: store.iso(comment.createdSeq) },
            },
          };
        }
        ctx.errors.push({ message: 'addComment: subject is not an issue' });
        return { type: 'AddCommentPayload', value: null };
      }
      return null;
    }
    case 'User': {
      if (field.name in (value as Record<string, unknown>)) return { type: 'Scalar', value: { __scalar: value[field.name] } };
      return null;
    }
    case 'Repository': {
      const repo = value.__repo as Repo;
      if (field.name === 'owner') {
        return {
          type: 'User',
          value: { login: repo.owner, id: globalId('User', store.identity.viewerId), databaseId: store.identity.viewerId, name: store.identity.viewerName, email: store.identity.viewerEmail, url: `https://github.com/${repo.owner}`, avatarUrl: '' },
        };
      }
      if (field.name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return { type: 'Ref', value: null };
        return { type: 'Ref', value: { name: repo.defaultBranch, prefix: 'refs/heads/', __oid: tip } };
      }
      if (field.name === 'issue') {
        const number = args.number;
        if (typeof number !== 'number') return null;
        const issue = repo.issues.find((i) => i.number === number);
        if (issue === undefined) return { type: 'Issue', value: null };
        return issueRuntime(store, repo, issue);
      }
      if (field.name === 'issues') {
        return { type: 'IssueConnection', value: { __connection: issuesConnection(store, repo, args) } };
      }
      if (field.name === 'pullRequest') {
        const number = args.number;
        if (typeof number !== 'number') return null;
        const pull = repo.pulls.find((p) => p.number === number);
        if (pull === undefined) return { type: 'PullRequest', value: null };
        return pullRuntime(store, repo, pull);
      }
      if (field.name === 'pullRequests') {
        return { type: 'PullRequestConnection', value: { __connection: pullsConnection(store, repo, args) } };
      }
      if (field.name in (value as Record<string, unknown>)) return { type: 'Scalar', value: { __scalar: value[field.name] } };
      return null;
    }
    case 'Ref': {
      if (field.name === 'target') {
        const oid = value.__oid as string;
        return { type: 'Commit', value: { oid, message: '', author: null, committer: null } };
      }
      if (field.name in (value as Record<string, unknown>)) return { type: 'Scalar', value: { __scalar: value[field.name] } };
      return null;
    }
    case 'Issue': {
      const issue = value.__issue as Issue;
      const repo = value.__repo as Repo;
      if (field.name === 'author') {
        return { type: 'User', value: { login: store.viewerLogin(), id: globalId('User', store.identity.viewerId), databaseId: store.identity.viewerId, name: store.identity.viewerName, email: store.identity.viewerEmail, url: `https://github.com/${store.viewerLogin()}`, avatarUrl: '' } };
      }
      if (field.name === 'labels') {
        return { type: 'LabelConnection', value: { __connection: { nodes: issue.labels.map((l) => ({ type: 'Label', value: { name: l.name, color: l.color, description: l.description } })), edges: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: issue.labels.length } } };
      }
      if (field.name === 'comments') {
        const nodes = issue.comments.map((c) => ({
          type: 'IssueComment',
          value: { id: globalId('IssueComment', repo.id, issue.number, c.id), databaseId: c.id, body: c.body, createdAt: store.iso(c.createdSeq), updatedAt: store.iso(c.createdSeq) },
        }));
        return { type: 'IssueCommentConnection', value: { __connection: { nodes, edges: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: nodes.length } } };
      }
      if (field.name in (value as Record<string, unknown>)) return { type: 'Scalar', value: { __scalar: value[field.name] } };
      return null;
    }
    case 'PullRequest': {
      const pull = value.__pull as Pull;
      const repo = value.__repo as Repo;
      if (field.name === 'author') {
        return { type: 'User', value: { login: store.viewerLogin(), id: globalId('User', store.identity.viewerId), databaseId: store.identity.viewerId, name: store.identity.viewerName, email: store.identity.viewerEmail, url: `https://github.com/${store.viewerLogin()}`, avatarUrl: '' } };
      }
      if (field.name === 'mergeable') {
        const state = pull.state === 'open' ? (store.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING') : 'UNKNOWN';
        return { type: 'Scalar', value: { __scalar: state } };
      }
      if (field.name === 'mergeCommit') {
        if (pull.mergeCommitSha === null) return { type: 'Commit', value: null };
        return { type: 'Commit', value: { oid: pull.mergeCommitSha, message: '', author: null, committer: null } };
      }
      if (field.name === 'headRef' || field.name === 'baseRef') {
        const branch = field.name === 'headRef' ? pull.headRef : pull.baseRef;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) return { type: 'Ref', value: null };
        return { type: 'Ref', value: { name: branch, prefix: 'refs/heads/', __oid: tip } };
      }
      if (field.name === 'files') {
        const files = store.pullFiles(repo, pull).map((f) => ({
          type: 'PullRequestChangedFile',
          value: { path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'DELETED' : 'MODIFIED' },
        }));
        const first = typeof args.first === 'number' ? args.first : null;
        const page = first === null ? files : files.slice(0, first);
        return {
          type: 'PullRequestChangedFileConnection',
          value: {
            __connection: {
              nodes: page,
              edges: page.map((node) => ({ node, cursor: '' })),
              pageInfo: { hasNextPage: first !== null && files.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
              totalCount: files.length,
            },
          },
        };
      }
      if (field.name === 'additions' || field.name === 'deletions' || field.name === 'changedFiles') {
        const files = store.pullFiles(repo, pull);
        const total = field.name === 'additions' ? files.reduce((s, f) => s + f.additions, 0) : field.name === 'deletions' ? files.reduce((s, f) => s + f.deletions, 0) : files.length;
        return { type: 'Scalar', value: { __scalar: total } };
      }
      if (field.name in (value as Record<string, unknown>)) return { type: 'Scalar', value: { __scalar: value[field.name] } };
      return null;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'IssueCommentConnection':
    case 'LabelConnection': {
      const connection = value.__connection as ConnectionResult;
      if (field.name === 'nodes') return { type: 'List', value: { __list: connection.nodes } };
      if (field.name === 'edges') {
        const edgeType = runtime.type === 'IssueConnection' ? 'IssueEdge' : runtime.type === 'PullRequestConnection' ? 'PullRequestEdge' : runtime.type === 'PullRequestChangedFileConnection' ? 'PullRequestChangedFileEdge' : 'IssueCommentEdge';
        return { type: 'List', value: { __list: connection.edges.map((e) => ({ type: edgeType, value: { __node: e.node, cursor: e.cursor } })) } };
      }
      if (field.name === 'pageInfo') {
        return { type: 'PageInfo', value: { hasNextPage: connection.pageInfo.hasNextPage, hasPreviousPage: connection.pageInfo.hasPreviousPage, startCursor: connection.pageInfo.startCursor, endCursor: connection.pageInfo.endCursor } };
      }
      if (field.name === 'totalCount') return { type: 'Scalar', value: { __scalar: connection.totalCount } };
      return null;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestChangedFileEdge':
    case 'IssueCommentEdge': {
      if (field.name === 'node') return value.__node as RuntimeValue;
      if (field.name === 'cursor') return { type: 'Scalar', value: { __scalar: value.cursor } };
      return null;
    }
    case 'PageInfo': {
      if (field.name in (value as Record<string, unknown>)) return { type: 'Scalar', value: { __scalar: value[field.name] } };
      return null;
    }
    case 'PullRequestChangedFile':
    case 'Comment':
    case 'IssueComment':
    case 'Label':
    case 'Commit': {
      if (field.name in (value as Record<string, unknown>)) return { type: 'Scalar', value: { __scalar: value[field.name] } };
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') {
        const issue = value.__issue as Issue;
        const repo = value.__repo as Repo;
        return issueRuntime(store, repo, issue);
      }
      if (field.name === 'clientMutationId') return { type: 'Scalar', value: { __scalar: null } };
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') {
        const pull = value.__pull as Pull;
        const repo = value.__repo as Repo;
        return pullRuntime(store, repo, pull);
      }
      if (field.name === 'actor') {
        return { type: 'User', value: { login: store.viewerLogin(), id: globalId('User', store.identity.viewerId), databaseId: store.identity.viewerId, name: store.identity.viewerName, email: store.identity.viewerEmail, url: `https://github.com/${store.viewerLogin()}`, avatarUrl: '' } };
      }
      if (field.name === 'clientMutationId') return { type: 'Scalar', value: { __scalar: null } };
      return null;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') {
        const comment = value.__comment as { id: string; body: string; createdAt: string };
        return { type: 'IssueCommentEdge', value: { __node: { type: 'IssueComment', value: { id: comment.id, body: comment.body, createdAt: comment.createdAt } }, cursor: '' } };
      }
      if (field.name === 'clientMutationId') return { type: 'Scalar', value: { __scalar: null } };
      return null;
    }
    case '__Type': {
      const typeName = value.__typeName as string;
      if (field.name === 'name') return { type: 'Scalar', value: { __scalar: typeName } };
      if (field.name === 'kind') return { type: 'Scalar', value: { __scalar: TYPE_FIELDS[typeName] !== undefined ? 'OBJECT' : typeName === 'SearchType' ? 'ENUM' : 'OBJECT' } };
      if (field.name === 'description') return { type: 'Scalar', value: { __scalar: null } };
      if (field.name === 'fields') {
        const names = TYPE_FIELDS[typeName] ?? [];
        return {
          type: 'List',
          value: {
            __list: names.map((n) => ({ type: '__Field', value: { name: n, description: null, args: [], type: { name: 'String', kind: 'SCALAR' } } })),
          },
        };
      }
      if (field.name === 'enumValues') {
        if (typeName !== 'SearchType') return { type: 'List', value: { __list: [] } };
        return { type: 'List', value: { __list: SEARCH_TYPE_VALUES.map((n) => ({ type: '__EnumValue', value: { name: n, description: null } })) } };
      }
      if (field.name === 'possibleTypes') return { type: 'List', value: { __list: [] } };
      return null;
    }
    case '__Field':
    case '__EnumValue': {
      if (field.name in (value as Record<string, unknown>)) return { type: 'Scalar', value: { __scalar: value[field.name] } };
      return null;
    }
    case '__Schema': {
      if (field.name === 'queryType') return { type: '__Type', value: { __typeName: 'Query' } };
      if (field.name === 'mutationType') return { type: '__Type', value: { __typeName: 'Mutation' } };
      if (field.name === 'types') {
        const names = [...Object.keys(TYPE_FIELDS), 'SearchType'];
        return { type: 'List', value: { __list: names.map((n) => ({ type: '__Type', value: { __typeName: n } })) } };
      }
      return null;
    }
    default:
      return null;
  }
}

function issuesConnection(store: Store, repo: Repo, args: Record<string, unknown>): ConnectionResult {
  let issues = [...repo.issues];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states !== null) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    issues = issues.filter((i) => wanted.has(i.state));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const direction = orderBy !== null && orderBy.direction === 'ASC' ? 1 : -1;
  issues.sort((a, b) => (a.createdSeq - b.createdSeq) * direction || (a.number - b.number) * direction);
  const nodes = issues.map((i) => issueRuntime(store, repo, i));
  const first = typeof args.first === 'number' ? args.first : null;
  const after = typeof args.after === 'string' ? args.after : null;
  return paginateConnection(nodes, first, after, 'Issue', repo.id);
}

function pullsConnection(store: Store, repo: Repo, args: Record<string, unknown>): ConnectionResult {
  let pulls = [...repo.pulls];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states !== null) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    pulls = pulls.filter((p) => wanted.has(pullState(p)));
  } else {
    pulls = pulls.filter((p) => p.state === 'open');
  }
  pulls.sort((a, b) => b.createdSeq - a.createdSeq);
  const nodes = pulls.map((p) => pullRuntime(store, repo, p));
  const first = typeof args.first === 'number' ? args.first : null;
  const after = typeof args.after === 'string' ? args.after : null;
  return paginateConnection(nodes, first, after, 'PullRequest', repo.id);
}

/** Execute a selection set against a runtime value, collecting unknown-field errors. */
function executeSelections(ctx: ExecContext, runtime: RuntimeValue, selections: SelectionNode[]): Record<string, unknown> | null {
  if (runtime.value === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.name !== null) {
        const definition = ctx.fragments.get(selection.name);
        if (definition === undefined) continue;
        if (definition.typeCondition !== runtime.type && !(runtime.type === 'Node' && definition.typeCondition === 'Repository')) continue;
        const nested = executeSelections(ctx, runtime, definition.selections);
        if (nested !== null) Object.assign(out, nested);
        continue;
      }
      if (selection.typeCondition !== null && selection.typeCondition !== runtime.type) continue;
      const nested = executeSelections(ctx, runtime, selection.selections);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = runtime.type;
      continue;
    }
    const resolved = resolveField(ctx, runtime, selection);
    if (resolved === null) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${runtime.type}"` });
      continue;
    }
    out[key] = materialize(ctx, resolved, selection.selections);
  }
  return out;
}

/** Turn a resolved runtime value into its JSON form, recursing into sub-selections. */
function materialize(ctx: ExecContext, runtime: RuntimeValue, selections: SelectionNode[]): unknown {
  if (runtime.value === null) return null;
  if (runtime.type === 'Scalar') return (runtime.value as Record<string, unknown>).__scalar ?? null;
  if (runtime.type === 'List') {
    const list = (runtime.value as Record<string, unknown>).__list as RuntimeValue[];
    return list.map((item) => materialize(ctx, item, selections));
  }
  if (selections.length === 0) return null;
  return executeSelections(ctx, runtime, selections);
}

/** Execute one parsed document. Returns the GraphQL result object. */
export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>): Record<string, unknown> {
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'failed to parse the GraphQL document' }] };
  }
  const fragments = new Map<string, FragmentDefinitionNode>();
  let operation: OperationNode | null = null;
  for (const definition of document.definitions) {
    if (definition.kind === 'fragmentDefinition') fragments.set(definition.name, definition);
    else if (operation === null) operation = definition;
  }
  if (operation === null) return { data: null, errors: [{ message: 'the document carries no operation' }] };
  const ctx: ExecContext = { store, variables, fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: RuntimeValue = { type: rootType, value: {} };
  const data = executeSelections(ctx, root, operation.selections);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

export interface GraphQLRequest {
  method: string;
  headers: Map<string, string>;
  body: Buffer;
}

export interface GraphQLResponse {
  status: number;
  body: unknown;
}

/** Returns null when the path is not the GraphQL endpoint. */
export function handleGraphQL(store: Store, segments: string[], req: GraphQLRequest): GraphQLResponse | null {
  if (segments.length !== 2 || segments[0] !== 'api' || segments[1] !== 'graphql') return null;
  if (req.method !== 'POST') return { status: 404, body: { message: 'Not Found' } };
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (match === null || match[1] !== store.token) {
    return { status: 401, body: { message: 'Bad credentials' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch {
    return { status: 400, body: { message: 'Problems parsing JSON' } };
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { data: null, errors: [{ message: 'a GraphQL request needs a query string' }] };
    }
    const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
    return executeGraphQL(store, entry.query, variables);
  };
  if (Array.isArray(parsed)) return { status: 200, body: parsed.map(runOne) };
  return { status: 200, body: runOne(parsed) };
}
