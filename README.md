# github-core-clone

A GitHub-compatible git forge, written in TypeScript on Node 22 with the
standard library only — no dependencies, no install step, no git binary.

## What it is

A self-contained forge that speaks the protocols GitHub clients speak:

- **Git smart HTTP** (`/<owner>/<repo>.git/`): `info/refs` advertisements in
  protocol v0 and v2, `ls-refs`, `fetch` (full, incremental and shallow with
  `deepen` / `deepen-since` / `deepen-not`), and `git-receive-pack` (create,
  update, delete, fast-forward checks, mixed ok/ng reports over sideband).
  Packs are written and read in the plain (non-delta) form; the pack reader
  also resolves `OFS_DELTA` and `REF_DELTA` entries, so real git clients can
  push thin packs.
- **REST v3** (`/api/v3/`): repositories, branches, commits, contents (read,
  create, update, delete — every write lands as a real git commit in the same
  object store the smart HTTP serves), refs, labels, issues, comments and
  pull requests, including squash merge with a three-way conflict check.
- **GraphQL v4** (`/api/graphql`): `viewer`, `repository`, `node`, issues and
  pull requests with cursor pagination, the create/close/merge/comment
  mutations, batching, and `__type` introspection.
- **MCP** (`/mcp`): Streamable HTTP, legacy era `2025-11-25`, with six tools —
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`.
- **Web UI** (`/`): a minimal read-only HTML surface over repositories,
  issues and pull requests.

All state lives in memory; a fresh server starts empty. The viewer the
bearer token names is `adaiversen` (the competition scenario's fixed viewer).

## Running it

```sh
node --experimental-strip-types main.ts
```

The server binds its own ephemeral port (never 8080), registers it with the
environment (`POST $MAKEFUN_ENV_URL/register {"port": <port>}` within 20 s),
answers `GET /healthz` with 200, long-polls `GET $MAKEFUN_ENV_URL/done`, and
exits 0 when the run is over. With no `MAKEFUN_ENV_URL` set it simply serves
until killed.

## Layout

| File | Contents |
| --- | --- |
| `main.ts` | Entry point: lifecycle (register / healthz / done) and the router. |
| `server.ts` | HTTP plumbing: request context, JSON replies, auth, request ids, pagination. |
| `store.ts` | The data model and the git graph: reachability, merge-base, diff, squash merge. |
| `gitobj.ts` | Git object, pack and pkt-line primitives (hashing, trees, commits, tags, deltas, packs). |
| `git.ts` | The git smart-HTTP surfaces. |
| `rest.ts` | The REST v3 API. |
| `graphql.ts` | The GraphQL parser, executor and introspection. |
| `mcp.ts` | The MCP endpoint and its six tools. |

## License

MIT — see `LICENSE`.
