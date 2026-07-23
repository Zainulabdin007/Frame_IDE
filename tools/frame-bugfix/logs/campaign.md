STARTED_UTC=2026-07-21T15:51:17Z
Bug-hunt loop: 9 x 1200s (~3h). First pass runs in chat now.
2026-07-21T15:53:23Z Pass1: fixed ready-race, modelLoaded reinit, error settle, 120s fork timeout, send timeout, post failure, terminate on send fail, plan auto-approve, gguf-only path resolve, activate clears stale path, import resolves .gguf, edit mode→Edit kind, product frame.ai.* commands, create no overwrite, chat Apply copy. compile-client 0 errors.
2026-07-21T15:59:19Z Pass2: adapter rediscover, listFiles blank path, git stubs error, tool permission override, RAG if/for exclude, tool-loop cap final answer, incomplete fence flush, memory folder reload, LM picker applies model. compile below.
2026-07-21T16:02:32Z Pass3: memory load finally-clear, chat memory folder reset, unload try/catch, llama dispose on load fail, cancel scopes tools by requestId, cleared dead frame.local URLs.
2026-07-21T16:05:03Z Pass4: knowledge _byPath file-only, bootstrap promise, ensureIndexed healthy-only, import path probe, reanalyze preserves Active/Rejected, observations folder reload.
2026-07-21T16:11:54Z Tick1: RAG clears/reloads on workspace folder change. compile-client 0 errors. Campaign continues via 20m loop (9 ticks).
2026-07-22T16:25:38Z Ticks2-6 catch-up: model picker never requires cloud setup; preference-review reloads on folder change + clears sticky load. compile-client 0 errors.
2026-07-22T16:32:56Z Tick7: knowledge clears+queues rebuild on folder change (no stale graph); adapters clear when folder missing/empty; chat status GitHub settings/billing → workbench.view.frameAI. compile-client 0 errors.
2026-07-22T17:26:33Z Tick8: stripped debug localhost ingest fetches (worker+runtime); model/key stores retarget _ready on folder change; RAG generation token discards stale reindex/load. compile-client 0 errors.
2026-07-22T19:28:00Z Tick9: background idle pass queues when already running (no dropped refreshes); tool-exec log no longer says stub. compile-client 0 errors.

## FINAL — 3h Frame bug-hunt campaign
ENDED_UTC≈2026-07-22T19:24:33Z (loop shell exit 0 after tick 9 + done)
Verification: `npm run compile-client` last run 0 errors (tick 9).

### What was fixed (high level)
- Worker/runtime: ready race, 120s fork timeout, modelLoaded reinit, error settle, cancel scopes tools, unload/dispose, tool-loop cap + fence flush, stripped debug localhost ingest.
- Chat/UI: Edit→FrameTaskKind.Edit, plan auto-approve, model picker no cloud setup, upgrade/spend→Frame sidebar, status GitHub→frameAI, Create no overwrite, Apply copy, product frame.ai.* commands, dead frame.local URLs cleared.
- Workspace reload: knowledge/RAG/adapters/memory/prefs/observations/models/keys clear or retarget on folder change; RAG generation token; knowledge rebuild queue.
- Tools/RAG/memory: listFiles blank path, git stub errors, permission override, RAG if/for exclude, import path probe, etc.
- Launch: FRAME_KEEP_RUNNING skips pkill.

### Intentionally left / residual
- Agent-host / extensions/copilot merge cost — not fully excised.
- Some gated Copilot command IDs remain for referrers (handlers redirect to Frame).
- Training/hardware largely scaffold; plan-review UI not wired (auto-approve).
- Docs may lag UI (FRAME_RUNTIME_UI.md etc.).

### Suggested smoke
- `./scripts/launch-frame.sh` with GGUF under `.frame` or `~/.frame`; Chat Ask/Edit; folder switch; Stop during generate.
