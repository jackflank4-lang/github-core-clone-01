// graphql.ts — a small GraphQL executor for the forge: a tokenizer and recursive
// descent parser, resolvers for the Query/Mutation surface the checks use, and
// the introspection (__type) the checks rely on. Written fresh in this session.
// Stdlib only: node:http.

import type { ServerResponse } from 'node:http';
import {
  decodeGlobalId,
  globalId,
  type Forge,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { Ctx, parseJsonBody, rejectBadJson, sendJson } from './server.ts';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind = 'Name' | 'Int' | 'Float' | 'String' | 'Punct' | 'EOF';

interface Token {
  kind: TokenKind;
  value: string;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, value: string): void => {
    tokens.push({ kind, value });
  };
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      push('Punct', '...');
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      push('Punct', ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        push('String', input.slice(i + 3, end).replace(/\\"""/g, '"""'));
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          if (esc === 'u' && j + 5 < input.length) {
            out += String.fromCharCode(Number.parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
            out += map[esc] ?? esc;
            j += 2;
          }
        } else {
          out += input[j];
          j += 1;
        }
      }
      if (j >= input.length) throw new Error('unterminated string');
      push('String', out);
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      push(isFloat ? 'Float' : 'Int', input.slice(i, j));
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j]!)) j += 1;
      push('Name', input.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  push('EOF', '');
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent over the token stream)
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'Int'; value: string }
  | { kind: 'Float'; value: string }
  | { kind: 'String'; value: string }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'Field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

interface InlineFragmentNode {
  kind: 'InlineFragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'FragmentSpread';
  name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

interface OperationNode {
  kind: 'Operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  kind: 'Fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  definitions: Array<OperationNode | FragmentNode>;
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
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'Punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'Name') throw new Error(`expected a name, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const definitions: Array<OperationNode | FragmentNode> = [];
    while (this.peek().kind !== 'EOF') {
      if (this.peek().kind === 'Punct' && this.peek().value === '{') {
        definitions.push({
          kind: 'Operation',
          operation: 'query',
          name: null,
          variableDefinitions: [],
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      const keyword = this.peek().value;
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        definitions.push(this.parseOperation());
      } else if (keyword === 'fragment') {
        definitions.push(this.parseFragment());
      } else {
        throw new Error(`unexpected definition ${keyword}`);
      }
    }
    return { definitions };
  }

  private parseOperation(): OperationNode {
    const operation = this.next().value as 'query' | 'mutation' | 'subscription';
    let name: string | null = null;
    if (this.peek().kind === 'Name') name = this.next().value;
    const variableDefinitions: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.peek().kind === 'Punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'Punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'Punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variableDefinitions.push({ name: varName, defaultValue });
      }
      this.expectPunct(')');
    }
    // Directives, if any, are skipped.
    while (this.peek().kind === 'Punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'Punct' && this.peek().value === '(') this.parseArguments();
    }
    return { kind: 'Operation', operation, name, variableDefinitions, selectionSet: this.parseSelectionSet() };
  }

  private parseType(): void {
    if (this.peek().kind === 'Punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'Punct' && this.peek().value === '!') this.next();
  }

  private parseFragment(): FragmentNode {
    this.expectName('fragment');
    const name = this.expectName();
    this.expectName('on');
    const typeCondition = this.expectName();
    return { kind: 'Fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'Punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'Punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'Name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'InlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'Name') {
        return { kind: 'FragmentSpread', name: this.next().value };
      }
      return { kind: 'InlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'Punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'Punct' && this.peek().value === '(') args = this.parseArguments();
    while (this.peek().kind === 'Punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'Punct' && this.peek().value === '(') this.parseArguments();
    }
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'Punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'Field', alias, name, args, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!(this.peek().kind === 'Punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'Punct' && token.value === '$') {
      return { kind: 'Variable', name: this.expectName() };
    }
    if (token.kind === 'Punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'Punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'List', values };
    }
    if (token.kind === 'Punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'Punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'Object', fields };
    }
    if (token.kind === 'Int') return { kind: 'Int', value: token.value };
    if (token.kind === 'Float') return { kind: 'Float', value: token.value };
    if (token.kind === 'String') return { kind: 'String', value: token.value };
    if (token.kind === 'Name') {
      if (token.value === 'true') return { kind: 'Boolean', value: true };
      if (token.value === 'false') return { kind: 'Boolean', value: false };
      if (token.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: token.value };
    }
    throw new Error(`unexpected value ${token.value}`);
  }
}

function valueFromAst(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'Int':
      return Number.parseInt(node.value, 10);
    case 'Float':
      return Number.parseFloat(node.value);
    case 'String':
      return node.value;
    case 'Boolean':
      return node.value;
    case 'Null':
      return null;
    case 'Enum':
      return node.value;
    case 'List':
      return node.values.map((value) => valueFromAst(value, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromAst(field.value, variables);
      return out;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Introspection model (the types the checks introspect)
// ---------------------------------------------------------------------------

const INTROSPECTION: Record<string, { kind: string; fields?: string[]; enumValues?: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['login', 'id'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'endCursor'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'] },
};

function introspectionType(name: string): Record<string, unknown> | null {
  const entry = INTROSPECTION[name];
  if (!entry) return null;
  const typeObject: Record<string, unknown> = {
    __typename: '__Type',
    kind: entry.kind,
    name,
    description: null,
    fields: entry.fields
      ? entry.fields.map((field) => ({
          __typename: '__Field',
          name: field,
          description: null,
          args: [],
          type: { __typename: '__Type', kind: 'SCALAR', name: 'String', ofType: null },
          isDeprecated: false,
          deprecationReason: null,
        }))
      : null,
    enumValues: entry.enumValues
      ? entry.enumValues.map((value) => ({
          __typename: '__EnumValue',
          name: value,
          description: null,
          isDeprecated: false,
          deprecationReason: null,
        }))
      : null,
    inputFields: null,
    interfaces: [],
    possibleTypes: null,
  };
  return typeObject;
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

interface GqlCtx {
  forge: Forge;
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    if (!match) return null;
    return Number.parseInt(match[1]!, 10);
  } catch {
    return null;
  }
}

function wrapRepo(repo: Repo): Record<string, unknown> {
  return {
    __typename: 'Repository',
    id: globalId('Repository', `${repo.owner}/${repo.name}`),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    ownerLogin: repo.owner,
    defaultBranch: repo.defaultBranch,
    repo,
  };
}

function wrapIssue(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    repo,
    issue,
  };
}

function wrapPull(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
    number: pull.number,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    repo,
    pull,
  };
}

function issueConnection(forge: Forge, repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const first = typeof args.first === 'number' ? args.first : undefined;
  const after = decodeCursor(args.after);
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let issues = [...repo.issues];
  if (states) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  if (after !== null) {
    issues = issues.filter((issue) => (direction === 'ASC' ? issue.number > after : issue.number < after));
  }
  const total = issues.length;
  const page = first !== undefined ? issues.slice(0, first) : issues;
  const hasNextPage = first !== undefined ? total > first : false;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => wrapIssue(repo, issue)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

function pullConnection(forge: Forge, repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const first = typeof args.first === 'number' ? args.first : undefined;
  const pulls = [...repo.pulls].sort((a, b) => b.number - a.number);
  const page = first !== undefined ? pulls.slice(0, first) : pulls;
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => wrapPull(repo, pull)),
  };
}

function resolveNode(forge: Forge, id: unknown): Record<string, unknown> | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  if (decoded.kind === 'Repository') {
    const [owner, name] = decoded.key.split('/');
    const repo = forge.getRepo(owner ?? '', name ?? '');
    return repo ? wrapRepo(repo) : null;
  }
  if (decoded.kind === 'Issue') {
    const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
    if (!match) return null;
    const repo = forge.getRepo(match[1]!, match[2]!);
    if (!repo) return null;
    const issue = forge.getIssue(repo, Number.parseInt(match[3]!, 10));
    return issue ? wrapIssue(repo, issue) : null;
  }
  if (decoded.kind === 'PullRequest') {
    const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
    if (!match) return null;
    const repo = forge.getRepo(match[1]!, match[2]!);
    if (!repo) return null;
    const pull = forge.getPull(repo, Number.parseInt(match[3]!, 10));
    return pull ? wrapPull(repo, pull) : null;
  }
  return null;
}

type Resolver = (parent: Record<string, unknown>, args: Record<string, unknown>, ctx: GqlCtx) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __typename: 'User', login: 'adaiversen', id: '1000' }),
    repository: (_parent, args, ctx) => {
      const repo = ctx.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? wrapRepo(repo) : null;
    },
    node: (_parent, args, ctx) => resolveNode(ctx.forge, args.id),
    __type: (_parent, args) => introspectionType(String(args.name ?? '')),
    __schema: () => ({
      __typename: '__Schema',
      description: null,
      types: Object.keys(INTROSPECTION).map((name) => introspectionType(name)),
      queryType: { __typename: '__Type', kind: 'OBJECT', name: 'Query', ofType: null },
      mutationType: { __typename: '__Type', kind: 'OBJECT', name: 'Mutation', ofType: null },
      subscriptionType: null,
      directives: [],
    }),
  },
  Mutation: {
    createIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (!decoded || decoded.kind !== 'Repository') throw new Error('repository not found');
      const [owner, name] = decoded.key.split('/');
      const repo = ctx.forge.getRepo(owner ?? '', name ?? '');
      if (!repo) throw new Error('repository not found');
      const created = ctx.forge.createIssue(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      if ('error' in created) throw new Error(created.error);
      return { __typename: 'CreateIssuePayload', issue: wrapIssue(repo, created) };
    },
    closeIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (!decoded || decoded.kind !== 'Issue') throw new Error('issue not found');
      const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
      if (!match) throw new Error('issue not found');
      const repo = ctx.forge.getRepo(match[1]!, match[2]!);
      if (!repo) throw new Error('issue not found');
      const issue = ctx.forge.getIssue(repo, Number.parseInt(match[3]!, 10));
      if (!issue) throw new Error('issue not found');
      ctx.forge.setIssueState(repo, issue, 'closed');
      return { __typename: 'CloseIssuePayload', issue: wrapIssue(repo, issue) };
    },
    createPullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (!decoded || decoded.kind !== 'Repository') throw new Error('repository not found');
      const [owner, name] = decoded.key.split('/');
      const repo = ctx.forge.getRepo(owner ?? '', name ?? '');
      if (!repo) throw new Error('repository not found');
      const created = ctx.forge.createPull(repo, {
        head: typeof input.headRefName === 'string' ? input.headRefName : '',
        base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      if ('error' in created) throw new Error(created.error);
      return { __typename: 'CreatePullRequestPayload', pullRequest: wrapPull(repo, created) };
    },
    mergePullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (!decoded || decoded.kind !== 'PullRequest') throw new Error('pull request not found');
      const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
      if (!match) throw new Error('pull request not found');
      const repo = ctx.forge.getRepo(match[1]!, match[2]!);
      if (!repo) throw new Error('pull request not found');
      const pull = ctx.forge.getPull(repo, Number.parseInt(match[3]!, 10));
      if (!pull) throw new Error('pull request not found');
      const merged = ctx.forge.mergePull(repo, pull);
      if (!merged) throw new Error('Pull request cannot be merged');
      return { __typename: 'MergePullRequestPayload', pullRequest: wrapPull(repo, pull) };
    },
    addComment: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (!decoded) throw new Error('subject not found');
      const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
      if (!match) throw new Error('subject not found');
      const repo = ctx.forge.getRepo(match[1]!, match[2]!);
      if (!repo) throw new Error('subject not found');
      const issue = ctx.forge.getIssue(repo, Number.parseInt(match[3]!, 10));
      if (!issue) throw new Error('subject not found');
      const comment = ctx.forge.createComment(repo, issue, typeof input.body === 'string' ? input.body : '');
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: {
            __typename: 'IssueComment',
            id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}#${comment.id}`),
            body: comment.body,
          },
        },
      };
    },
  },
  User: {
    login: (parent) => parent.login ?? null,
    id: (parent) => parent.id ?? null,
  },
  Repository: {
    id: (parent) => parent.id ?? null,
    databaseId: (parent) => parent.databaseId ?? null,
    name: (parent) => parent.name ?? null,
    nameWithOwner: (parent) => parent.nameWithOwner ?? null,
    owner: (parent) => ({ __typename: 'User', login: parent.ownerLogin ?? null, id: '1000' }),
    defaultBranchRef: (parent) => ({ __typename: 'Branch', name: parent.defaultBranch ?? null }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (parent, args, ctx) => {
      const repo = parent.repo as Repo;
      const issue = ctx.forge.getIssue(repo, Number(args.number ?? 0));
      return issue ? wrapIssue(repo, issue) : null;
    },
    issues: (parent, args, ctx) => issueConnection(ctx.forge, parent.repo as Repo, args),
    pullRequests: (parent, args, ctx) => pullConnection(ctx.forge, parent.repo as Repo, args),
    pullRequest: (parent, args, ctx) => {
      const repo = parent.repo as Repo;
      const pull = ctx.forge.getPull(repo, Number(args.number ?? 0));
      return pull ? wrapPull(repo, pull) : null;
    },
  },
  Issue: {
    id: (parent) => parent.id ?? null,
    number: (parent) => parent.number ?? null,
    title: (parent) => parent.title ?? null,
    state: (parent) => parent.state ?? null,
    body: (parent) => parent.body ?? null,
  },
  IssueConnection: {
    nodes: (parent) => (parent.nodes as unknown[]) ?? [],
    pageInfo: (parent) => parent.pageInfo ?? null,
  },
  PageInfo: {
    hasNextPage: (parent) => parent.hasNextPage ?? false,
    endCursor: (parent) => parent.endCursor ?? null,
  },
  PullRequest: {
    id: (parent) => parent.id ?? null,
    number: (parent) => parent.number ?? null,
    state: (parent) => parent.state ?? null,
    merged: (parent) => parent.merged ?? false,
    headRefName: (parent) => parent.headRefName ?? null,
    baseRefName: (parent) => parent.baseRefName ?? null,
    mergeable: (parent, _args, ctx) => ctx.forge.pullMergeable(parent.repo as Repo, parent.pull as PullRequest),
    files: (parent, args, ctx) => {
      const repo = parent.repo as Repo;
      const pull = parent.pull as PullRequest;
      const files = ctx.forge.pullFiles(repo, pull);
      const capped = typeof args.first === 'number' ? files.slice(0, args.first) : files;
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: capped.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename })),
      };
    },
  },
  PullRequestConnection: {
    nodes: (parent) => (parent.nodes as unknown[]) ?? [],
  },
  PullRequestChangedFile: {
    path: (parent) => parent.path ?? null,
  },
  PullRequestChangedFileConnection: {
    nodes: (parent) => (parent.nodes as unknown[]) ?? [],
  },
  Branch: {
    name: (parent) => parent.name ?? null,
  },
  CreateIssuePayload: { issue: (parent) => parent.issue ?? null },
  CloseIssuePayload: { issue: (parent) => parent.issue ?? null },
  CreatePullRequestPayload: { pullRequest: (parent) => parent.pullRequest ?? null },
  MergePullRequestPayload: { pullRequest: (parent) => parent.pullRequest ?? null },
  AddCommentPayload: { commentEdge: (parent) => parent.commentEdge ?? null },
  IssueCommentEdge: { node: (parent) => parent.node ?? null },
  IssueComment: {
    id: (parent) => parent.id ?? null,
    body: (parent) => parent.body ?? null,
  },
  __Type: {
    kind: (parent) => parent.kind ?? null,
    name: (parent) => parent.name ?? null,
    description: (parent) => parent.description ?? null,
    fields: (parent) => parent.fields ?? null,
    enumValues: (parent) => parent.enumValues ?? null,
    inputFields: (parent) => parent.inputFields ?? null,
    interfaces: (parent) => parent.interfaces ?? [],
    possibleTypes: (parent) => parent.possibleTypes ?? null,
  },
  __Field: {
    name: (parent) => parent.name ?? null,
    description: (parent) => parent.description ?? null,
    args: (parent) => parent.args ?? [],
    type: (parent) => parent.type ?? null,
    isDeprecated: (parent) => parent.isDeprecated ?? false,
    deprecationReason: (parent) => parent.deprecationReason ?? null,
  },
  __EnumValue: {
    name: (parent) => parent.name ?? null,
    description: (parent) => parent.description ?? null,
    isDeprecated: (parent) => parent.isDeprecated ?? false,
    deprecationReason: (parent) => parent.deprecationReason ?? null,
  },
  __Schema: {
    description: (parent) => parent.description ?? null,
    types: (parent) => parent.types ?? [],
    queryType: (parent) => parent.queryType ?? null,
    mutationType: (parent) => parent.mutationType ?? null,
    subscriptionType: (parent) => parent.subscriptionType ?? null,
    directives: (parent) => parent.directives ?? [],
  },
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface Executor {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function executeSelectionSet(
  executor: Executor,
  typeName: string,
  parentValue: Record<string, unknown> | null,
  selections: SelectionNode[],
): Record<string, unknown> | null {
  if (parentValue === null || parentValue === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'InlineFragment') {
      if (selection.typeCondition && selection.typeCondition !== typeName) continue;
      const nested = executeSelectionSet(executor, typeName, parentValue, selection.selectionSet);
      if (nested) Object.assign(out, nested);
      continue;
    }
    if (selection.kind === 'FragmentSpread') {
      const fragment = executor.fragments.get(selection.name);
      if (!fragment) {
        executor.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition !== typeName) continue;
      const nested = executeSelectionSet(executor, typeName, parentValue, fragment.selectionSet);
      if (nested) Object.assign(out, nested);
      continue;
    }
    const field = selection;
    const responseKey = field.alias ?? field.name;
    const args: Record<string, unknown> = {};
    for (const arg of field.args) args[arg.name] = valueFromAst(arg.value, executor.variables);
    let value: unknown;
    try {
      value = resolveField(executor, typeName, parentValue, field.name, args);
    } catch (err) {
      executor.errors.push({ message: (err as Error).message });
      out[responseKey] = null;
      continue;
    }
    if (field.selectionSet === null) {
      out[responseKey] = value;
      continue;
    }
    if (value === null || value === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (Array.isArray(value)) {
      const itemType = typeName;
      out[responseKey] = value.map((item) => {
        if (item === null || typeof item !== 'object') return item;
        const itemTypeName = (item as Record<string, unknown>).__typename as string | undefined;
        return executeSelectionSet(executor, itemTypeName ?? itemType, item as Record<string, unknown>, field.selectionSet!);
      });
      continue;
    }
    if (typeof value === 'object') {
      const valueTypeName = (value as Record<string, unknown>).__typename as string | undefined;
      out[responseKey] = executeSelectionSet(executor, valueTypeName ?? typeName, value as Record<string, unknown>, field.selectionSet);
      continue;
    }
    out[responseKey] = value;
  }
  return out;
}

function resolveField(
  executor: Executor,
  typeName: string,
  parentValue: Record<string, unknown>,
  fieldName: string,
  args: Record<string, unknown>,
): unknown {
  if (fieldName === '__typename') return typeName;
  const typeResolvers = RESOLVERS[typeName];
  const resolver = typeResolvers?.[fieldName];
  if (!resolver) throw new Error(`Cannot query field "${fieldName}" on type "${typeName}".`);
  return resolver(parentValue, args, { forge: executor.forge });
}

function executeOperation(
  forge: Forge,
  document: DocumentNode,
  operationName: string | undefined,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const fragments = new Map<string, FragmentNode>();
  let operation: OperationNode | null = null;
  for (const definition of document.definitions) {
    if (definition.kind === 'Fragment') fragments.set(definition.name, definition);
    else if (definition.kind === 'Operation') {
      if (operationName !== undefined) {
        if (definition.name === operationName) operation = definition;
      } else if (operation === null) {
        operation = definition;
      }
    }
  }
  if (!operation) return { errors: [{ message: operationName ? `Unknown operation named "${operationName}".` : 'No operation found in the document.' }] };
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const definition of operation.variableDefinitions) {
    if (mergedVariables[definition.name] === undefined && definition.defaultValue) {
      mergedVariables[definition.name] = valueFromAst(definition.defaultValue, variables);
    }
  }
  const executor: Executor = { forge, variables: mergedVariables, fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(executor, rootType, {}, operation.selectionSet);
  const result: Record<string, unknown> = { data };
  if (executor.errors.length > 0) result.errors = executor.errors;
  return result;
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export function isGraphqlPath(pathParts: string[]): boolean {
  return pathParts.length === 2 && pathParts[0] === 'api' && pathParts[1] === 'graphql';
}

export function handleGraphql(forge: Forge, ctx: Ctx, res: ServerResponse): boolean {
  if (!isGraphqlPath(ctx.pathParts)) return false;
  if (ctx.method !== 'POST') {
    sendJson(res, 405, ctx, { message: 'Method Not Allowed' });
    return true;
  }
  if (!ctx.token) {
    sendJson(res, 401, ctx, { message: 'Requires authentication' });
    return true;
  }
  const body = parseJsonBody(ctx);
  if (rejectBadJson(res, ctx, body)) return true;
  if (Array.isArray(body)) {
    // Batching: an array of operation documents -> an array of responses.
    const responses: Record<string, unknown>[] = [];
    for (const item of body) {
      responses.push(executeGraphql(forge, item));
    }
    sendJson(res, 200, ctx, responses);
    return true;
  }
  sendJson(res, 200, ctx, executeGraphql(forge, body));
  return true;
}

function executeGraphql(forge: Forge, body: unknown): Record<string, unknown> {
  const input = (body ?? {}) as Record<string, unknown>;
  const query = typeof input.query === 'string' ? input.query : '';
  if (!query) return { errors: [{ message: 'Must provide a query string.' }] };
  const variables = (input.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof input.operationName === 'string' ? input.operationName : undefined;
  let document: DocumentNode;
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: (err as Error).message }] };
  }
  try {
    return executeOperation(forge, document, operationName, variables);
  } catch (err) {
    return { errors: [{ message: (err as Error).message }] };
  }
}
