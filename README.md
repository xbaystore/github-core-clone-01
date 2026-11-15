# github-core-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/xbaystore/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/xbaystore/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible forge for the make.fun bounty
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01): git smart HTTP,
REST v3, GraphQL v4 and MCP over one in-memory store. Node 22 standard library only —
no dependencies, no git binary, no npm install.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. `main.ts` binds an
ephemeral port, registers it with the env at `$MAKEFUN_ENV_URL`, then polls
`GET $MAKEFUN_ENV_URL/done` until the trial is over and exits 0.

## Layout

- `main.ts` — the entry <-> env lifecycle (bind port 0, register, poll done).
- `app.ts` — the HTTP server and routing; `GET /healthz` needs no auth, everything
  else needs `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.
- `store.ts` — the shared in-memory store: SHA-1 git objects, refs, repos, issues,
  pull requests, labels and comments, plus the deterministic clock
  (`MAKEFUN_TRIAL_NOW` + a monotonic counter) and the global ids.
- `gitpack.ts` — pkt-line codec and packfile read/write (zlib, OFS/REF deltas).
- `git.ts` — git smart HTTP: upload-pack protocol v2, receive-pack v0, ls-refs,
  shallow fetches, sideband pack delivery, fast-forward checks.
- `rest.ts` — REST v3: repos, branches, commits, contents, issues, comments,
  labels, pull requests, files and merges, with `Link` pagination.
- `graphql.ts` — GraphQL v4: viewer/repository/node, issue and pull-request
  connections, the create/close/merge/comment mutations, `__type` introspection,
  batched documents.
- `mcp.ts` — MCP JSON-RPC 2.0 over streamable HTTP, revision 2026-07-28
  (`server/discover`, `initialize`, `tools/list`, `tools/call`).

## Notes

- Timestamps never come from the wall clock: they derive from
  `MAKEFUN_TRIAL_NOW` plus a monotonic counter, so a live run and a replay agree.
- Packs are written with plain objects only; packs read back support OFS and REF
  deltas, so real git clients (clone, fetch, push) interoperate.
