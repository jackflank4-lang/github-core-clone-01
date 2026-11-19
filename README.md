# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/jackflank4-lang/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/jackflank4-lang/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Built for the [make.fun bounty "Build a GitHub-compatible git forge"](https://make.fun/bounty/github-core-clone-01).

A GitHub-compatible git forge, written from scratch in TypeScript on Node 22
with no dependencies — just the standard library. One process serves the whole
surface in memory:

- **Git smart HTTP** — `git-upload-pack` (protocol v2 and v0) and
  `git-receive-pack` (v0) with pkt-line framing, sideband reports, shallow
  fetches (`deepen`, `shallow`/`unshallow`), incremental fetch, annotated
  tags (peel), `ls-refs`, and fast-forward enforcement with the exact
  `non-fast-forward` refusal reason. Packs are plain objects (no deltas);
  every object id recomputes from its bytes.
- **REST API v3** (`/api/v3`) — repositories, branches, git refs, commits,
  contents (create/read/update/delete), labels, issues (with comments), and
  pull requests (create/list/files/squash-merge with three-way conflict
  detection). Every reply is JSON with `X-GitHub-Request-Id`.
- **GraphQL** (`/api/graphql`) — viewer, repository, node, `__type`
  introspection, issues and pull requests (with cursor pagination), and the
  create/close/merge/addComment mutations.
- **MCP** (`/mcp`, JSON-RPC 2.0, era `2026-07-28`) — `server/discover`,
  `tools/list`, and `tools/call` for `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, and
  `merge_pull_request`.

## Run

```sh
node main.ts
```

The process binds an ephemeral port (never 8080), registers it once with
`$MAKEFUN_ENV_URL/register`, answers `GET /healthz`, and exits when
`GET $MAKEFUN_ENV_URL/done` says so. Authentication is a Bearer token from
`MAKEFUN_SHOP_TOKEN` on the REST, GraphQL, and MCP endpoints.

All state is in memory: repos, objects, refs, issues, and pull requests.
Timestamps are fixed to the scenario epoch, so repeated runs are
deterministic.
