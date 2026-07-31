# `@haneoka/vega-plugin-spine`

Spine JSON and binary character support for Vega.

- Descriptor validation for JSON and binary skeletons
- Cancellation-safe lifecycle handling
- Host-supplied runtime adapter
- Serializable multi-track animation queue

```sh
pnpm add @haneoka/vega @haneoka/vega-plugin-spine
```

The package does not bundle a Spine runtime or Spine project data. Applications
must supply a compatible runtime under the terms applicable to that runtime
and content.

Character entries use Spine's ordinary exported file pairs. No format tag or
plugin-only metadata is required:

```ts
const jsonCharacter = {
  runtime: {
    json: "/characters/hero/hero.json",
    atlas: "/characters/hero/hero.atlas",
  },
};

const binaryCharacter = {
  runtime: {
    skel: "/characters/hero/hero.skel",
    atlas: "/characters/hero/hero.atlas",
  },
};
```

The aliases `runtime.skeleton` and top-level `json`, `skel`, `skeleton`, and
`atlas` are also accepted. Source-specific packages are responsible for
mapping their metadata into this standard skeleton/atlas pair.

```ts
import { VegaEngine } from "@haneoka/vega";
import { createSpinePlugin } from "@haneoka/vega-plugin-spine";

const spine = createSpinePlugin({
  adapter: {
    id: "my-authorized-runtime",
    prepare: (signal) => runtime.prepare(signal),
    create: (context) => runtime.createDomModel(context),
    createForRenderer: (context) => runtime.createRendererModel(context),
    disposeRendererModel: (model) => runtime.dispose(model),
  },
});

const engine = new VegaEngine({ plugins: [spine] });
```

The adapter controls runtime creation, rendering, and cleanup.

## License

MPL-2.0. The package does not include the Spine runtime or project assets.
