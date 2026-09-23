import {
  defineVegaPlugin,
  type StoryCharacterModel,
  type StoryCharacterModelContext,
  type StoryCharacterProvider,
  type StoryCharacterResource,
  type StoryCharacterResourceEnumerationContext,
} from "@haneoka/vega/plugin";

export interface SpineModelDescriptor {
  readonly skeletonSource: string;
  readonly atlasSource: string;
  readonly binary: boolean;
  readonly scale: number;
  readonly defaultSkin?: string;
  readonly defaultAnimation?: string;
}

export interface SpineRendererCharacterRequest extends StoryCharacterModelContext {
  readonly renderer: string;
  readonly rendererContext: unknown;
  readonly descriptor?: unknown;
}

export interface SpineRendererCharacterContext extends StoryCharacterModelContext {
  readonly renderer: string;
  readonly rendererContext: unknown;
  readonly descriptor: SpineModelDescriptor;
}

/**
 * Applications supply a Spine runtime they are licensed to use. Keeping the
 * runtime behind this port lets Vega, Altair and Deneb reason about the plugin
 * without embedding Esoteric Software code in the official package.
 */
export interface SpineRuntimeAdapter {
  readonly id: string;
  prepare?(signal: AbortSignal): void | Promise<void>;
  create(
    context: StoryCharacterModelContext & {
      readonly descriptor: SpineModelDescriptor;
    },
  ): StoryCharacterModel | Promise<StoryCharacterModel>;
  createForRenderer?(context: SpineRendererCharacterContext): unknown | Promise<unknown>;
  disposeRendererModel?(model: unknown, context: SpineRendererCharacterContext): void | Promise<void>;
}

export interface CreateSpinePluginOptions {
  readonly adapter: SpineRuntimeAdapter;
  readonly formats?: readonly string[];
  readonly contributionId?: string;
}

const DEFAULT_FORMATS = Object.freeze(["spine", "spine-json", "spine-binary"]);

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const firstString = (...values: unknown[]): string =>
  values.map((value) => (typeof value === "string" ? value.trim() : "")).find(Boolean) ?? "";

const standardSpineFormat = (entry: StoryCharacterModelContext["entry"]): string => {
  const source = object(entry);
  const runtime = object(source.runtime);
  const binary = firstString(runtime.skel, source.skel);
  if (binary) return "spine-binary";
  const json = firstString(runtime.json, source.json);
  if (json) return "spine-json";
  const skeleton = firstString(runtime.skeleton, source.skeleton);
  if (!skeleton) return "";
  if (/\.skel(?:[?#].*)?$/iu.test(skeleton)) {
    return "spine-binary";
  }
  if (/\.json(?:[?#].*)?$/iu.test(skeleton)) {
    return "spine-json";
  }
  const explicit = firstString(runtime.format, source.format).toLowerCase();
  if (explicit === "spine" || explicit === "spine-json" || explicit === "spine-binary") {
    return explicit;
  }
  return "";
};

const positive = (value: unknown, fallback = 1): number => {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : fallback;
};

const abortReason = (signal: AbortSignal): unknown => {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The Spine model request was aborted");
  error.name = "AbortError";
  return error;
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw abortReason(signal);
};

const disposeRendererModel = async (
  adapter: SpineRuntimeAdapter,
  model: unknown,
  context: SpineRendererCharacterContext,
): Promise<void> => {
  if (adapter.disposeRendererModel) {
    await adapter.disposeRendererModel(model, context);
    return;
  }
  if (!model || typeof model !== "object") return;
  const candidate = model as {
    dispose?: () => void | Promise<void>;
    destroy?: () => void | Promise<void>;
    release?: () => void | Promise<void>;
  };
  if (typeof candidate.dispose === "function") await candidate.dispose();
  else if (typeof candidate.destroy === "function") await candidate.destroy();
  else if (typeof candidate.release === "function") await candidate.release();
};

export const describeSpineModel = (entry: StoryCharacterModelContext["entry"]): SpineModelDescriptor | null => {
  const source = object(entry);
  const runtime = object(source.runtime);
  const binarySource = firstString(runtime.skel, source.skel);
  const jsonSource = firstString(runtime.json, source.json);
  const genericSource = firstString(runtime.skeleton, source.skeleton);
  const skeletonSource = binarySource || jsonSource || genericSource;
  const atlasSource = firstString(runtime.atlas, source.atlas);
  if (!skeletonSource || !atlasSource) return null;
  const format = standardSpineFormat(entry);
  return {
    skeletonSource,
    atlasSource,
    binary:
      format === "spine-binary" || Boolean(binarySource) || (!jsonSource && /\.skel(?:[?#].*)?$/iu.test(genericSource)),
    scale: positive(runtime.scale ?? source.scale),
    ...(firstString(runtime.skin, source.skin) ? { defaultSkin: firstString(runtime.skin, source.skin) } : {}),
    ...(firstString(runtime.animation, source.animation)
      ? { defaultAnimation: firstString(runtime.animation, source.animation) }
      : {}),
  };
};

const atlasPageNames = (atlas: string): readonly string[] => {
  const pages: string[] = [];
  let expectsPage = true;
  for (const line of atlas.split(/\r\n?|\n/u)) {
    const value = line.trim();
    if (!value) {
      expectsPage = true;
      continue;
    }
    if (!expectsPage) continue;
    // Spine 4.2 permits atlas-wide `key: value` header entries before the
    // first page. They describe the atlas and are not texture file names.
    if (value.includes(":")) continue;
    pages.push(value);
    expectsPage = false;
  }
  return Object.freeze(pages);
};

const ABSOLUTE_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
type SpineResourceResolver = StoryCharacterResourceEnumerationContext["resources"];

interface SharedSpineAtlas {
  readonly controller: AbortController;
  readonly pending: Promise<string>;
  waiters: number;
  settled: boolean;
}

type SpineAtlasCache = Map<string, SharedSpineAtlas>;

const atlasTextCaches = new WeakMap<SpineResourceResolver, SpineAtlasCache>();

const trimSpineAtlasCache = (cache: SpineAtlasCache): void => {
  while (cache.size > 128) {
    let removed = false;
    for (const [source, shared] of cache) {
      // In-flight entries remain addressable so concurrent enumerations never
      // create a second atlas request merely because the LRU is under pressure.
      if (!shared.settled) continue;
      cache.delete(source);
      removed = true;
      break;
    }
    if (!removed) return;
  }
};

const waitForSpineAtlas = (
  shared: SharedSpineAtlas,
  cache: SpineAtlasCache,
  source: string,
  signal: AbortSignal,
): Promise<string> => {
  if (signal.aborted) {
    if (shared.waiters === 0 && !shared.settled) {
      if (cache.get(source) === shared) cache.delete(source);
      shared.controller.abort(signal.reason);
    }
    return Promise.reject(abortReason(signal));
  }
  shared.waiters += 1;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      shared.waiters = Math.max(0, shared.waiters - 1);
      callback();
    };
    const aborted = () =>
      finish(() => {
        if (shared.waiters === 0 && !shared.settled) {
          if (cache.get(source) === shared) cache.delete(source);
          shared.controller.abort(signal.reason);
        }
        reject(abortReason(signal));
      });
    signal.addEventListener("abort", aborted, { once: true });
    shared.pending.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
};

const loadSpineAtlas = (resources: SpineResourceResolver, source: string, signal: AbortSignal): Promise<string> => {
  throwIfAborted(signal);
  let cache = atlasTextCaches.get(resources);
  if (!cache) {
    cache = new Map();
    atlasTextCaches.set(resources, cache);
  }
  const cached = cache.get(source);
  if (cached) {
    cache.delete(source);
    cache.set(source, cached);
    return waitForSpineAtlas(cached, cache, source, signal);
  }

  const controller = new AbortController();
  let shared!: SharedSpineAtlas;
  const pending = resources
    .load(source, controller.signal)
    .then((bytes) => new TextDecoder().decode(bytes))
    .catch((error: unknown) => {
      if (cache?.get(source) === shared) cache.delete(source);
      if (controller.signal.aborted) throw abortReason(controller.signal);
      throw error;
    })
    .finally(() => {
      shared.settled = true;
      if (cache) trimSpineAtlasCache(cache);
    });
  shared = { controller, pending, waiters: 0, settled: false };
  cache.set(source, shared);
  trimSpineAtlasCache(cache);
  return waitForSpineAtlas(shared, cache, source, signal);
};

/** Resolve page names relative to both hierarchical and host-owned atlas URLs. */
export const resolveSpineAtlasPageSource = (atlasSource: string, pageName: string): string => {
  const page = pageName.trim();
  if (!page) throw new TypeError("Spine atlas page name cannot be empty");

  if (ABSOLUTE_SCHEME.test(atlasSource)) {
    try {
      return new URL(page, atlasSource).toString();
    } catch (error) {
      const opaque = /^([A-Za-z][A-Za-z0-9+.-]*:)(?!\/\/)([^?#]*)(?:[?#].*)?$/u.exec(atlasSource);
      if (!opaque) throw error;
      if (ABSOLUTE_SCHEME.test(page)) return page;
      if (page.startsWith("//")) return `${opaque[1]}${page}`;
      const syntheticOrigin = "https://vega-spine-opaque.invalid";
      const syntheticBase = new URL(`/${opaque[2]!.replace(/^\/+/u, "")}`, syntheticOrigin);
      const resolved = new URL(page, syntheticBase);
      if (resolved.origin !== syntheticOrigin) return resolved.toString();
      return `${opaque[1]}${resolved.pathname.replace(/^\/+/u, "")}${resolved.search}${resolved.hash}`;
    }
  }

  if (atlasSource.startsWith("//")) {
    const resolved = new URL(page, `https:${atlasSource}`);
    if (ABSOLUTE_SCHEME.test(page)) return resolved.toString();
    return resolved.toString().replace(/^https:/u, "");
  }

  if (ABSOLUTE_SCHEME.test(page) || page.startsWith("//") || page.startsWith("/")) {
    return page;
  }
  const syntheticOrigin = "https://vega-spine-relative.invalid";
  const rooted = atlasSource.startsWith("/");
  const base = new URL(rooted ? atlasSource : `/${atlasSource}`, syntheticOrigin);
  const resolved = new URL(page, base);
  if (resolved.origin !== syntheticOrigin) return resolved.toString();
  const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  return rooted ? path : path.replace(/^\//u, "");
};

/**
 * Enumerate a standard skeleton, atlas, and every atlas page image.
 *
 * Spine animations are embedded in the JSON or binary skeleton, so there are
 * intentionally no separate animation resources to discover or preload.
 */
export const enumerateSpineResources = async (
  context: StoryCharacterResourceEnumerationContext,
): Promise<readonly StoryCharacterResource[]> => {
  const descriptor = describeSpineModel(context.entry);
  if (!descriptor) return [];
  throwIfAborted(context.signal);
  const atlas = await loadSpineAtlas(context.resources, descriptor.atlasSource, context.signal);
  throwIfAborted(context.signal);
  const pageSources = [
    ...new Set(atlasPageNames(atlas).map((pageName) => resolveSpineAtlasPageSource(descriptor.atlasSource, pageName))),
  ];
  const containsSelectedAnimation = Boolean(
    context.animationUsage &&
    (context.animationUsage.motions.length > 0 || context.animationUsage.expressions.length > 0),
  );
  return Object.freeze([
    Object.freeze({
      source: descriptor.skeletonSource,
      label: descriptor.binary ? "Spine binary skeleton" : "Spine JSON skeleton",
      ...(containsSelectedAnimation ? { role: "animation" as const } : {}),
    }),
    Object.freeze({
      source: descriptor.atlasSource,
      label: "Spine atlas",
    }),
    ...pageSources.map((source) =>
      Object.freeze({
        source,
        kind: "texture" as const,
        label: "Spine atlas page",
      }),
    ),
  ]);
};

export const createSpineCharacterProvider = (
  options: CreateSpinePluginOptions,
): StoryCharacterProvider & {
  createForRenderer(context: SpineRendererCharacterRequest): unknown | Promise<unknown>;
} => {
  if (!options.adapter?.id?.trim()) {
    throw new TypeError("A named Spine runtime adapter is required");
  }
  const formats = new Set(
    (options.formats ?? DEFAULT_FORMATS).map((format) => format.trim().toLowerCase()).filter(Boolean),
  );
  if (formats.size === 0) {
    throw new TypeError("At least one Spine format must be enabled");
  }
  const contributionId = options.contributionId?.trim() || "vega.spine";
  return {
    id: contributionId,
    supports(entry) {
      const format = standardSpineFormat(entry);
      if (!format) return false;
      return (
        (formats.has(format) || (format.startsWith("spine-") && formats.has("spine"))) &&
        describeSpineModel(entry) !== null
      );
    },
    enumerateResources(context) {
      return enumerateSpineResources(context);
    },
    async create(context) {
      const descriptor = describeSpineModel(context.entry);
      if (!descriptor) throw new TypeError("Spine model descriptor is incomplete");
      throwIfAborted(context.signal);
      await options.adapter.prepare?.(context.signal);
      throwIfAborted(context.signal);
      const model = await options.adapter.create({ ...context, descriptor });
      if (context.signal.aborted) {
        const reason = abortReason(context.signal);
        await model.dispose();
        throw reason;
      }
      return model;
    },
    async createForRenderer(context) {
      const descriptor = describeSpineModel(context.entry);
      if (!descriptor) throw new TypeError("Spine model descriptor is incomplete");
      const adapterContext: SpineRendererCharacterContext = {
        ...context,
        descriptor,
      };
      if (!options.adapter.createForRenderer) {
        throw new Error(`Spine adapter ${options.adapter.id} does not support renderer ${context.renderer}`);
      }
      throwIfAborted(context.signal);
      await options.adapter.prepare?.(context.signal);
      throwIfAborted(context.signal);
      const model = await options.adapter.createForRenderer(adapterContext);
      if (context.signal.aborted) {
        const reason = abortReason(context.signal);
        await disposeRendererModel(options.adapter, model, adapterContext);
        throw reason;
      }
      return model;
    },
  };
};

export const createSpinePlugin = (options: CreateSpinePluginOptions) => {
  const provider = createSpineCharacterProvider(options);
  return defineVegaPlugin({
    manifest: {
      id: "haneoka.spine",
      name: "Vega Spine",
      version: "0.1.0",
      apiVersion: 1,
      description: "Spine JSON/binary model discovery and lifecycle routing",
      capabilities: ["character"],
    },
    setup(context) {
      context.contribute("character", provider);
    },
  });
};

export interface SpineTrackRequest {
  readonly track: number;
  readonly animation: string;
  readonly loop?: boolean;
  readonly mixSeconds?: number;
}

/**
 * Small serializable queue used by previews, saves, and runtime adapters.
 * Renderer implementations consume it without exposing runtime objects to the
 * narrative engine.
 */
export class SpineTrackQueue {
  private readonly tracks = new Map<number, SpineTrackRequest[]>();

  enqueue(request: SpineTrackRequest): void {
    if (!Number.isSafeInteger(request.track) || request.track < 0) {
      throw new RangeError("Spine track must be a non-negative integer");
    }
    if (typeof request.animation !== "string" || !request.animation.trim()) {
      throw new TypeError("Spine animation name cannot be empty");
    }
    if (request.mixSeconds !== undefined && (!Number.isFinite(request.mixSeconds) || request.mixSeconds < 0)) {
      throw new RangeError("Spine mix duration must be a finite non-negative number");
    }
    const queue = this.tracks.get(request.track) ?? [];
    queue.push(Object.freeze({ ...request, animation: request.animation.trim() }));
    this.tracks.set(request.track, queue);
  }

  shift(track: number): SpineTrackRequest | undefined {
    const queue = this.tracks.get(track);
    const request = queue?.shift();
    if (!queue?.length) this.tracks.delete(track);
    return request;
  }

  snapshot(): Readonly<Record<string, readonly SpineTrackRequest[]>> {
    return Object.freeze(
      Object.fromEntries(
        [...this.tracks.entries()]
          .sort(([left], [right]) => left - right)
          .map(([track, queue]) => [
            String(track),
            Object.freeze(queue.map((request) => Object.freeze({ ...request }))),
          ]),
      ),
    );
  }

  clear(track?: number): void {
    if (track === undefined) this.tracks.clear();
    else this.tracks.delete(track);
  }
}

export default createSpinePlugin;
