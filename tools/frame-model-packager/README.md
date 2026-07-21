# frame-model-packager

Offline CLI to create and validate Frame `.frame-model` packages.

See [FRAME_MODEL_PACKAGING.md](../../FRAME_MODEL_PACKAGING.md).

```bash
node bin/frame-model-packager.mjs build --metadata ./examples/metadata.efficient.json --out /tmp/pkg
node bin/frame-model-packager.mjs validate --package /tmp/pkg
```

Does **not** download models, bundle real weights by default, or load inference.
