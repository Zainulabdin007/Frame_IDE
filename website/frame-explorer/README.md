# Frame showcase preview

Mirrors the two 16:9 marketing boxes on the Frame site (`Loom_web` at `localhost:5173`).

## Run

Prefer the live site — those boxes are wired there already.

For a standalone copy of styles/behavior:

```bash
cd website/frame-explorer
python3 -m http.server 8765
```

Open `http://localhost:5173/#about` and `#demo` for the real preview.

## Box contents

1. **About** — draggable Frame Desktop (Models / Search / SCM / Extensions) + Agent chat window; traffic lights minimize to a dock; green zooms.
2. **Demo** — Confirm before/after edit plan with Accept · Undo, then Learning preference Approve · Reject.
