# github-core-clone-01 — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/jackflank4-lang/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/jackflank4-lang/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone git forge in a single Node process: smart-HTTP git (protocol v2
upload-pack, v0 receive-pack), REST v3, GraphQL, and MCP — all backed by one
in-process store, with the packfile format implemented from scratch on the
Node standard library. No git binary, no database, no outside service, no
dependencies at all.

Built for the make.fun `github-core-clone-01` bounty: the conformance suite
is the only client, and the entry is graded on how many of its 120 checks
pass, plus MCP coverage and four timed workloads (push / clone / read /
write).

## Run it

Requires Node 22+ (the trial runs Node 22; developed on Node 24). No install
step — there are no dependencies.

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port on 127.0.0.1, registers it with the
environment (`POST $MAKEFUN_ENV_URL/register {"port": N}`), then long-polls
`GET $MAKEFUN_ENV_URL/done` until the environment says `{"done": true}`,
and exits 0. The environment must provide:

- `MAKEFUN_ENV_URL` — the env service (register/done)
- `MAKEFUN_SHOP_TOKEN` — the bearer token the suite authenticates with; the
  entry treats that token's login as the seeded viewer
- `MAKEFUN_TRIAL_NOW` — ISO timestamp; all created/updated dates derive
  from it (no wall clock, so replays are deterministic)
- `MAKEFUN_TRIAL_SEED` — the scenario seed (viewer, repos, and ids are
  recomputed from it, so every trial is seeded identically)

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | Entrypoint: lifecycle (bind → register → poll done → exit 0). |
| `server.ts` | One Node `http` server; routes `/healthz`, `/api/v3`, `/api/graphql`, `/mcp`, `/{owner}/{repo}.git`. A handler that throws is answered 500 JSON and the process keeps serving. |
| `store.ts` | The in-process store: seeded scenario identity, repos, refs, issues, labels, comments, pull requests; contents writes via tree rebuilding; 3-way mergeability and squash merges; opaque base64 global ids; a logical clock off `MAKEFUN_TRIAL_NOW`. |
| `gitobj.ts` | Git objects: SHA-1 ids, commit/tag/tree parsing, pkt-lines, pack read/write (plain objects plus OFS/REF delta resolution), reachability, fetch selection with depth/shallow/unshallow, merge-base, tree flattening, line-diff counts. |
| `git.ts` | Smart HTTP: upload-pack v2 (advertisement, ls-refs, fetch) and v0, receive-pack v0 with `report-status` / `side-band-64k` / `delete-refs`. Fast-forward only; a non-fast-forward ref is refused with `ng <ref> non-fast-forward` and does not move, while a fast-forward ref in the same push still applies. |
| `rest.ts` | REST v3: root/meta/user, `/user/repos` (create 201 / duplicate 422, `Link: rel="next"` pagination), repos, branches, commits, git refs, contents (PUT 201/200/409, DELETE 200), labels, issues + comments, pulls + files + merge (405 on conflict). Every reply is `application/json` with a non-empty `X-GitHub-Request-Id`; unknown routes are 404 JSON, never HTML. |
| `graphql.ts` | A hand-written GraphQL parser (operations, variables, arguments, aliases, inline/named fragments, `__type`) plus typed resolvers for exactly the documents the suite sends: viewer, repository, issues, pull requests, search, node, and the create/close/merge mutations — all reading back over REST as the same objects. |
| `mcp.ts` | MCP over JSON-RPC 2.0 Streamable HTTP: `server/discover` (revision `2026-07-28`), legacy `initialize` + `notifications/initialized`, `ping`, `tools/list` (8 tools, byte-identical across calls), `tools/call` acting on the same store as REST. |
| `package.json` | `node --experimental-strip-types main.ts`; `tsconfig.json` is the starter's. |

## Surfaces, briefly

- **Git** — `/{owner}/{repo}.git/info/refs?service=git-upload-pack` and
  `.../git-receive-pack` (v0) / `git-upload-pack` (v2). Missing repo is 404
  on both services' `GET /info/refs`. Packfiles are version 2, plain
  objects (no deltas) on write; delta packs are read and resolved.
  A fetch with `done` gets no acknowledgments section (git goes straight
  to the packfile); a fetch without `done` is a negotiation round
  (NAK, or ACK + ready). The packfile section is always present, even for
  zero objects.
- **REST** — `/api/v3/...`. Auth is `Authorization: Bearer <token>`; no
  token is 401; the same repo name under another owner is 404, never 403.
- **GraphQL** — `POST /api/graphql`. Unknown field is HTTP 200 with an
  `errors` array naming it; unknown repo is `data.repository: null` with
  no errors; unauthenticated is exactly 401.
- **MCP** — `POST /mcp`. Unknown tool is -32602, missing required argument
  is `isError: true`, a non-JSON body is HTTP 400 with -32700, no
  authorization is 401.

## Determinism

No wall clock (dates from `MAKEFUN_TRIAL_NOW`), no `Math.random()` or
unseeded UUIDs (ids derive from `MAKEFUN_TRIAL_SEED`), and env requests go
one at a time in a fixed order — so a trial replays byte for byte.

## Local testing

`dev/` holds the dev-only scripts (not part of the entry — do not push):

- `dev/test-harness.mjs` — mock env + smoke test: 46 checks covering REST,
  GraphQL, MCP, and real `git clone` / `git push` / non-fast-forward
  refusal against the forge. Run with `node dev/test-harness.mjs`.
- `dev/bench-local.mjs` — the four timed workloads against a local forge
  (with `--cpu-prof`), printing per-workload p50 and points.

The kit's own grader is the authority:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> \
  --driver process --worktree --instances 3
```

(Docker is not installed in the dev VM; `--driver docker` fails with
ENOENT. Use `--driver process`.)

## Score

`grade-local --driver process --instances 3` on the practice trials
(16 Nov 2026): **948 / 972 / 948** — feature **600/600** (all 120
conformance checks pass on every trial), agent-native **200/200**,
performance 148–172/200 (the perf column varies with machine contention;
push hits 50/50, read 39–50, write 42–44, clone 32–46).

See `BUILD-REPORT.md` for the full breakdown, what was verified live, and
the known weaknesses.

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=g7tqc4ex&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
