# github-core-clone-01 — BUILD REPORT v2 (perf optimization)

Date: 2026-11-18. Base commit: `3a01d97` (the submitted entry, live score 943).
Optimized commit: **`49ffcbc`** ("Perf: cut per-request CPU on hot paths"), local only —
**NOT pushed, NOT submitted, NOT bundled** (parent's job).

## Goal

Score = Agent 200 + Feature 600 + Perf 200. Feature was already 600/600
(120/120 conformance), Agent 200/200. Only Perf moves. Live score 943
(perf live ~143); top 10 was 958, #1 966 at 18 Nov ~13:19 UTC.
Target: perf live ≥160 → score ≥960.

## What was wrong

The VM (1.5 shared CPUs) runs harness + env client + entry together, so
perf is CPU-contention-bound. The 18 Nov CPU profile of the baseline
(`bench-local.mjs` under `--cpu-prof`, 4,797 samples) showed 67.3% idle
and our own code only ~7% of busy time — but every request still paid for:
a per-request `Map` built from the raw headers, repeated JSON
serialization of the same issue on every read, repeated pack building for
the same depth-1 clone, and repeated ref-advertisement formatting.
Under 50 concurrent clones / 2,000 sequential reads, that per-request
work is the whole ball game.

## Changes (6 files, +182/−60)

- **store.ts** — new `getHeader(headers, name)` reading Node's raw
  lower-cased headers dict (no Map allocation per request); `Repo` gains
  `refsVersion` (init 0); new `setRef(repo, ref, oid)` /
  `deleteRef(repo, ref)` helpers that bump `refsVersion`; `writeFile`,
  `deleteFile`, `mergePull` now use `setRef`.
- **git.ts** — `GitRequest.headers` is now `NodeJS.Dict<string|string[]>`;
  `getHeader` used for `git-protocol`. Three response-level caches
  (module-level Maps, keyed by repo + `refsVersion`, so a ref write
  invalidates them):
  - `lsRefsCache` — full ls-refs response body;
  - `fetchCache` — full framed response body for the exact clone shape
    (single want, depth 1, `done`, no haves, no shallow, no filter /
    deepen-since). Safe by construction: objects are content-addressed
    and immutable, so the pack for a given want oid never changes.
    `infoRefsUpload` split into a cached wrapper + `buildInfoRefsUpload`;
  - `infoRefsCache` — info/refs advertisement bodies (v2/v0/upload/receive).
- **rest.ts** — `RestRequest.headers` raw dict; `RestResponse` gains
  optional `text` + `textLength` (pre-serialized body); `authCheck` uses
  `getHeader`; POST /git/refs uses `setRef`; `issueJson` node_id memoized
  via `WeakMap<Issue,string>`; new `issueJsonText(store, repo, issue)` —
  the serialized single-issue JSON cached in a `WeakMap<Issue,
  {version, text, length}>` with version =
  `${issue.updatedSeq}:${issue.comments.length}` (PATCH bumps
  `updatedSeq`; addComment grows `comments.length`; labels are never
  edited after creation — both mutation paths covered); the GET
  single-issue handler now returns the cached text.
- **server.ts** — `headersOf` deleted; handlers get `req.headers`
  directly; `decodeURIComponent` skipped for segments without `%`
  (malformed `%` still 400s via the retained try/catch); new `sendText()`
  for pre-serialized bodies; the REST branch serves `response.text`
  when present.
- **graphql.ts / mcp.ts** — same raw-headers plumbing (`headers` type +
  the one `authorization` lookup each via `getHeader`).

No behavior or API change. The caches only ever serve bytes the
uncached code would have produced for the same repo state, and every
cache key includes `refsVersion`, so a push that moves a ref invalidates
all three git caches before the next read.

## Verification

- **Typecheck** (`tsc --noEmit`, typescript from the spaces runtime +
  its `@types/node`): the only errors are the 3 pre-existing ones in
  `gitobj.ts:280-285` (`inflateAt`'s `{info:true}` / `result.engine`
  typing). Verified identical on pristine `3a01d97` via `git stash` —
  this change adds **zero new type errors**. (Note: `npx typescript`
  is broken in this VM — arborist error; use the spaces-runtime copy.)
- **Smoke test** `~/workspace/makefun/github-core-clone-dev/test-harness.mjs`:
  **46/46 passed**.
- **Grade-local, 3 trials, `--driver process --instances 3`** — Feature
  **600/600 on every trial** (conformance intact), replay matched
  byte-for-byte on every trial, 0 nondeterministic, entry exit 0.

## Results

Scoring: points per workload = `round(clamp(25 − 12.5·log2(p50 / T_ref), 0, 50))`,
T_ref: push 1640.82 ms, clone 266.94 ms, read 2759.72 ms, write 348.97 ms.

### Grade-local (the authoritative measurement)

| run | commit | trial 0 | trial 1 | trial 2 | mean perf | mean score |
|-----|--------|---------|---------|---------|-----------|------------|
| baseline | 3a01d97 | 184 / 984 | 183 / 983 | 175 / 975 | **180.67** | **980.67** |
| optimized A | 49ffcbc | 186 / 986 | 183 / 983 | 191 / 991 | **186.67** | **986.67** |
| optimized B | 49ffcbc | 183 / 983 | 182 / 982 | 189 / 989 | **184.67** | **984.67** |

Combined optimized (6 trials): **mean perf 185.67, mean score 985.67** —
**+5.0 perf points / +5.0 score over baseline**. 90% CI of the score:
run A 979.9–993.5, run B 978.3–991.0. Agent 200, Feature 600 on all 6
trials.

Per-workload p50 (ms), baseline mean → optimized mean (6 trials):

| workload | baseline p50 | optimized p50 | points baseline → optimized |
|----------|--------------|---------------|-----------------------------|
| push (200× 1 KiB) | 373.2 | 363.7 | 50 → 50 (maxed) |
| clone (50× depth-1) | 106.8 | 106.6* | 41.3 → 41.7 |
| read (2000× GET issue) | 751.7 | 736.0 | 47.7 → 48.3 |
| write (200× POST issue) | 133.3 | 120.9 | 42.3 → 44.3 |

\* Clone mean is skewed by one noisy trial (run B trial 1: 141.8 ms, 36 pts,
a contention spike). Median clone across the 6 optimized trials is
~99 ms vs ~107 ms baseline.

Trial dirs: baseline
`~/.makefun/trials/github-core-clone-01/01a1ef0c-49b2-7333-8782-063dfe8db6c5`;
optimized A `01a1ef15-4ab7-7466-bfac-8f3f5f6306e4`; optimized B
`01a1ef16-a8c9-7346-9682-4f83a5bf6e85` (per-trial perf in
`trial-N/state/perf.json`).

### Bench-local (no harness, `bench-local.mjs`, working tree)

Baseline: **166/200** (push 50 @ 290 ms, clone 32 @ 185 ms, read 47 @
805 ms, write 37 @ 181 ms).
Optimized, 4 runs: **190, 178, 189, 200/200** — clone 45–50 pts
(57–89 ms, was 185 ms), read 50 pts (601–630 ms), write 44–50 pts
(86–119 ms), push 50 pts. The local bench overstates the gain: its
clone client does 2 exchanges per clone (ls-refs + fetch) while the
suite's does 3 (info/refs GET + ls-refs + fetch), and its client is
lighter than the suite's undici client.

## Gotcha found while verifying (important for future runs)

**`grade-local` copies the bot from a git COMMIT, not the working
tree.** The first post-optimization grade-local run (180/178/185)
silently measured the OLD commit `3a01d97` because the changes were
still uncommitted — it looked like the optimization had done nothing.
Always `git commit` before `grade-local`, or the numbers lie.

## Honest assessment

+5 points grade-local is real and reproducible across two runs, and
Feature stayed 600/600. But the live score was 943 with the baseline
code while the same code grades 980.7 locally — a ~38-point
environment gap (the grading hardware is more contended than this VM).
If that gap is stable, the optimized entry lands live at roughly
**949, still short of the 958 top-10 line**. The remaining wall time is
dominated by the suite client's own work (undici + SHA-1 checksums +
pkt-line parsing for 50 concurrent clones) and Node's HTTP internals,
not by server code — the server's hot paths are now response-level
cached. Squeezing more would need riskier surgery (e.g. a raw TCP
server instead of node:http, or zero-copy response paths) with
regression risk this close to the 21 Nov 06:30 UTC close, and each
further change needs a full re-verification cycle. Recommendation:
submit `49ffcbc` as the final entry (parent's call) and take the +5.

## What is NOT done (parent's job)

- **No push** (remote HEAD is still `3a01d97`).
- **No submit, no bundle.** A fresh submit of `49ffcbc` is needed
  before 21 Nov 06:30 UTC — note the post-12:00 UTC 18 Nov run-record
  rules apply to the bundle (typed-prompt builder session +
  `--system-prompt`), and the bundle must be grep-scrubbed for
  credentials before submitting.
- The live score (943) is from the baseline code; the +5 is a
  grade-local projection, not a live measurement.
