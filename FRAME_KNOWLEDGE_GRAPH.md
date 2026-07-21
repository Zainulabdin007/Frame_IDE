# Frame Knowledge Graph

Structural workspace index for Frame Intelligence.

**Hard rules:** no models, no weights, no inference, no cloud APIs.  
**Does not replace RAG** — sits alongside lexical retrieval as a graph layer.

---

## Architecture

```
Workspace files
    ↓ (Monaco outline / LSP / heuristics)
FrameKnowledgeBuilder
    ↓
FrameKnowledgeGraph (nodes + edges)
    ↓
.frame/knowledge/  +  FrameKnowledgeQuery
    ↓
Context Engine  ·  Planner steps  ·  Tool calling  ·  Sidebar
```

### Node kinds

Workspace · Folders · Files · Symbols · Functions · Classes · Interfaces · Enums · Variables · Imports · Exports · Modules

### Edge kinds

`contains` · `imports` · `exports` · `inherits` · `implements` · `calls` · `references` · `declares` · `uses`

---

## Storage

Under each workspace folder:

```
.frame/knowledge/
  nodes.json
  edges.json
  metadata.json
  version.json
```

---

## Incremental indexing

File watchers (`IFileService.onDidFilesChange`) queue affected relative paths.

Only those paths are re-indexed (create / save / rename / delete / move / workspace folder change).

**Rebuild Index** in the Knowledge sidebar forces a full scan.

Sources (in order):

1. Monaco `IOutlineModelService` / document symbol providers when a text model resolves  
2. Deterministic regex heuristics for classes, functions, imports/exports, extends/implements, call-site names

---

## Context Engine

`IFrameInferenceContext` now includes (alongside RAG):

- `knowledgeGraph` — summary / health counts  
- `relatedSymbols`  
- `callHierarchy`  
- `dependencyGraph`  
- `affectedFiles`

---

## Planner

Deterministic steps can request:

- **Find Symbol** → `findSymbol`  
- **Analyze Dependency** → `findDependencies`  
- **Analyze Call Chain** → `findCallers`  
- **Analyze Module** → `findImplementations`

Execution pipeline unchanged: plan → review → execute.

---

## Tools

Worker-callable (no inference):

`findSymbol` · `findReferences` · `findDependencies` · `findCallers` · `findImplementations`

---

## Future model usage

When a local model is attached, the graph slice can be serialized into the prompt as structured facts (symbols, callers, dependents) without replacing RAG chunks. Training is out of scope — metadata and graph only.

---

## Next step

Surface a lightweight symbol search box in the Knowledge panel (query → `findSymbol` results list).
