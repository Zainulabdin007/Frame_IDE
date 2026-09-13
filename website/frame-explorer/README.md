# Frame showcase preview

Interactive stand-ins for the two marketing 16:9 boxes on the Frame site.

## What’s in each box

1. **Product overview** — Frame Desktop (activity + Models / Learning) beside an agent chat with local badge and tool trail.
2. **Confirm flow** — Before / after edit plan with Accept · Undo, then a learning preference Approve / Reject.

## Preview

```bash
cd website/frame-explorer
python3 -m http.server 8765
# open http://localhost:8765
```

The live site copies live in `Loom_web` (`src/cicada/cicadaMarkup.html`, `frameShowcases.css`, `initFrameShowcases.js`).
