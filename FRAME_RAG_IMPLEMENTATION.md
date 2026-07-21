# Frame RAG Implementation

Fully local workspace retrieval for Frame Intelligence. No cloud embeddings, no external APIs, no model calls.

## Goals

- Understand the opened workspace from disk
- Index meaningful code chunks under `.frame/rag/`
- Rank relevant chunks for a user request
- Feed ranked context into `IFrameInferenceContext` via the orchestrator

## Indexing flow

```
Workspace folders
        │
        ▼
 FrameWorkspaceScanner
   • walk tree via IFileService
   • skip node_modules, .git, build/out/dist, binaries, .frame
   • collect path, language, size
        │
        ▼
 FrameRagService.reindex / ensureIndex
   • read each file once
   • chunkSource() → structural chunks
   • extract symbol names from chunks
        │
        ▼
 FrameRagIndexStore.save
   • write <folder>/.frame/rag/meta.json
   • write workspace.json
   • write chunks.jsonl
```

On first `query()`, if no in-memory index exists, Frame loads `.frame/rag/` when present, otherwise runs a full reindex.

## Chunk format

In-memory / API type: `IFrameRagChunk`

| Field | Meaning |
| --- | --- |
| `id` | Stable UUID for the chunk |
| `uri` | Absolute file URI |
| `relativePath` | Path relative to workspace folder |
| `language` | Heuristic language id (`typescript`, `python`, …) |
| `kind` | `function` \| `class` \| `module` \| `block` |
| `symbolName` | Detected name when available |
| `startLine` / `endLine` | 1-based inclusive line range |
| `text` | Chunk source text |
| `score` | Set at query time by lexical ranker |
| `metadata` | Extra key/values (`path`, `language`, `kind`) |

### Chunking strategy

1. Prefer **functions / classes / types** via language-aware line regexes (TS/JS, Python, Go, Rust, Java/Kotlin/C#, fallbacks).
2. Brace languages extend to matching `}`; indentation helps Python-like ranges.
3. Cap oversized structural spans (~250 lines).
4. Fallback: overlapping **~80-line blocks**, plus a **module** preview (first ~40 lines) for large unstructured files.

## Storage format

Location (per workspace folder):

```
<workspace>/.frame/rag/
  meta.json
  workspace.json
  chunks.jsonl
<workspace>/.frame/.gitignore   # contains "*" so the index stays local
```

### `meta.json`

```json
{
  "version": 1,
  "createdAt": 0,
  "updatedAt": 0,
  "documentCount": 0,
  "chunkCount": 0,
  "folder": "file:///..."
}
```

### `workspace.json`

```json
{
  "folder": "file:///...",
  "files": [
    {
      "path": "src/auth.py",
      "language": "python",
      "size": 1234,
      "symbols": ["login", "AuthService"]
    }
  ]
}
```

### `chunks.jsonl`

One JSON object per line:

```json
{
  "id": "...",
  "path": "src/auth.py",
  "uri": "file:///.../src/auth.py",
  "language": "python",
  "kind": "function",
  "symbolName": "login",
  "startLine": 10,
  "endLine": 42,
  "text": "def login(...):\n  ...",
  "metadata": { "path": "src/auth.py", "language": "python", "kind": "function" }
}
```

No database server. Plain files only.

## Retrieval process

API: `IFrameRagService.query(IFrameRagQuery)`

Input context:

- `text` — user request
- `activeUri` — current editor file (boost)
- `selectionText` — selected code (boost)
- `workspaceFolders` — scan/index scope
- `limit` / `maxChars` — result budget

Algorithm (`ragRetrieval.ts`):

1. Tokenize the request (stop-word filtered).
2. Score each chunk:
   - basename / path hits
   - symbol name hits
   - body occurrences
   - selection-token overlap
   - active-file boost
   - small preference for function/class kinds
3. Sort descending; take top `limit` within `maxChars`.
4. Build ranked distinct `files` list from winning chunks.

Example:

> User: “Fix authentication bug”

> Files: `auth.py`, `database.py`, `models.py` (plus ranked chunks with line ranges)

## Orchestrator integration

```
User request (Frame AI UI)
        │
        ▼
 FrameOrchestratorService.submitTask
   • collect activeUri + selection from code editor
   • memory.query(...)
   • rag.query({ text, activeUri, selectionText, workspaceFolders })
        │
        ▼
 IFrameInferenceContext
   • files: ranked paths
   • rag: ranked chunks
   • memory: local entries
   • activeAdapters
   • messages / systemPrompt
```

Status remains `AwaitingModel`. **No model is called.**

Index-only path: `FrameTaskKind.Index` → `rag.reindex()`.

## Privacy

- All I/O is local filesystem via VS Code `IFileService`
- `.frame/` is gitignored by Frame when created
- Scanner never uploads content
- Ranking is lexical only — no remote embedding service

## Future embedding integration

When a local embedding runtime is available (e.g. small on-device model via llama.cpp / MLX):

1. Keep the same chunk + storage layout.
2. Add optional `embedding: number[]` (or a sidecar `embeddings.bin` / `embeddings.jsonl`) keyed by chunk `id`.
3. At query time: hybrid score = lexical + cosine(local embedding).
4. Fall back to current lexical ranker when embeddings are missing.
5. Still never call cloud embedding APIs unless the user explicitly opts in later.

Until then, lexical retrieval is the production path for Frame RAG.

## Key source files

| Path | Role |
| --- | --- |
| `rag/workspaceScanner.ts` | Workspace walk + ignore rules |
| `rag/ragIgnore.ts` | Ignore dirs/binaries/language map |
| `rag/codeChunker.ts` | Structural chunking |
| `rag/ragIndexStore.ts` | `.frame/rag/` persistence |
| `rag/ragRetrieval.ts` | Lexical ranking |
| `rag/frameRagService.ts` | Public RAG service |
| `orchestrator/frameOrchestratorService.ts` | Context assembly |
