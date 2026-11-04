import type * as Three from "three";
import type * as Spine from "@esotericsoftware/spine-threejs";
import type { ThreeStoryCharacterModel } from "@haneoka/vega-renderer-three";
import type { SpineRuntimeAdapter } from "./index.js";

export function createSpineThreeRuntimeAdapter({
  three,
  spine,
}: {
  three: typeof Three;
  spine: typeof Spine;
}): SpineRuntimeAdapter {
  return {
    id: "spine-three",
    create() {
      throw new Error("Spine requires the Three renderer");
    },
    async createForRenderer(context) {
      const rendererContext = context.rendererContext as {
        threeRenderer?: Three.WebGLRenderer;
        gl?: WebGL2RenderingContext;
      };
      if (!rendererContext.threeRenderer || !rendererContext.gl)
        throw new Error("Spine requires a Three WebGL2 context");
      const renderer = rendererContext.threeRenderer,
        gl = rendererContext.gl;
      const { descriptor, resources, signal } = context;
      const bitmaps: ImageBitmap[] = [];
      let atlas: Spine.TextureAtlas | undefined, mesh: Spine.SkeletonMesh | undefined;
      try {
        const [atlasBytes, skeletonBytes] = await Promise.all([
          resources.load(descriptor.atlasSource, signal),
          resources.load(descriptor.skeletonSource, signal),
        ]);
        signal.throwIfAborted();
        atlas = new spine.TextureAtlas(new TextDecoder().decode(atlasBytes));
        for (const page of atlas.pages) {
          const source = relativeResource(descriptor.atlasSource, page.name);
          const bytes = await resources.load(source, signal);
          signal.throwIfAborted();
          const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
            premultiplyAlpha: page.pma ? "none" : "premultiply",
            colorSpaceConversion: "none",
          });
          bitmaps.push(bitmap);
          signal.throwIfAborted();
          page.setTexture(new spine.ThreeJsTexture(bitmap, true));
        }
        const loader = new spine.AtlasAttachmentLoader(atlas);
        const parser = descriptor.binary ? new spine.SkeletonBinary(loader) : new spine.SkeletonJson(loader);
        parser.scale = descriptor.scale;
        const data = parser.readSkeletonData(
          descriptor.binary ? skeletonBytes : JSON.parse(new TextDecoder().decode(skeletonBytes)),
        );
        mesh = new spine.SkeletonMesh({
          skeletonData: data,
          twoColorTint: true,
          materialFactory: (parameters) =>
            new three.MeshBasicMaterial({ ...parameters, depthTest: false, depthWrite: false, forceSinglePass: true }),
        });
        preservePainterOrder(mesh, spine);
        const initialSkin =
          descriptor.defaultSkin ??
          data.skins.find((skin) => skin.name === "default")?.name ??
          data.skins[0]?.name ??
          "";
        if (initialSkin) mesh.skeleton.setSkinByName(initialSkin);
        mesh.skeleton.setToSetupPose();
        const initialMotion =
          descriptor.defaultAnimation ??
          data.animations.find((animation) => ["f_idle", "idle"].includes(animation.name))?.name ??
          data.animations[0]?.name;
        if (initialMotion) mesh.state.setAnimation(0, initialMotion, true);
        mesh.update(0);
        const scene = new three.Scene();
        scene.add(mesh);
        const camera = new three.Camera();
        camera.matrixAutoUpdate = false;
        const surface = mesh,
          offset = new spine.Vector2(),
          size = new spine.Vector2(),
          vertices: number[] = [];
        const authored = {
          x: data.x * descriptor.scale,
          y: data.y * descriptor.scale,
          width: data.width * descriptor.scale,
          height: data.height * descriptor.scale,
        };
        const bounds = () => {
          surface.skeleton.getBounds(offset, size, vertices);
          return { x: offset.x, y: offset.y, width: size.x, height: size.y };
        };
        const setup = bounds();
        const canvas = authored.width > 0 && authored.height > 0 ? authored : setup;
        let paused = false,
          suspended = false,
          speed = 1,
          released = false,
          updateSerial = 0,
          drawSerial = 0,
          currentSkin = initialSkin;
        const model: ThreeStoryCharacterModel = {
          format: descriptor.binary ? "spine-binary" : "spine-json",
          modelUrl: descriptor.skeletonSource,
          pixelsPerUnit: 1 / descriptor.scale,
          get isOperational() {
            return !released;
          },
          get updateSerial() {
            return updateSerial;
          },
          get drawSerial() {
            return drawSerial;
          },
          get isMotionPlaying() {
            return surface.state.tracks.some((track) => track && (!track.isComplete() || track.loop));
          },
          motionSyncStatus: "unconfigured",
          setPaused(value) {
            paused = value;
          },
          setClockSuspended(value) {
            suspended = value;
          },
          setMotionSpeed(value) {
            speed = value;
          },
          setEyeBlinkEnabled() {},
          resetMotionSync() {},
          setParameter() {},
          parameterRange() {
            return null;
          },
          eyeBallPosition() {
            return { x: 0, y: 0 };
          },
          setEyeBallPosition() {},
          forceEyeBallPosition() {},
          hasMotion(name) {
            return !!data.findAnimation(name);
          },
          hasExpression(name) {
            return !!data.findSkin(name);
          },
          async prepareMotion(name) {
            return !!data.findAnimation(name);
          },
          async prepareExpression(name) {
            return !!data.findSkin(name);
          },
          playMotion(name, fade = 0) {
            if (!data.findAnimation(name)) return false;
            const track = surface.state.setAnimation(0, name, false);
            track.mixDuration = fade;
            return true;
          },
          playExpression(name) {
            if (!data.findSkin(name)) return false;
            surface.skeleton.setSkinByName(name);
            surface.skeleton.setSlotsToSetupPose();
            currentSkin = name;
            surface.update(0);
            return true;
          },
          resetExpressionParametersToDefault() {
            if (initialSkin) model.playExpression(initialSkin);
          },
          isCurrentExpression(name) {
            return currentSkin === name;
          },
          refreshCurrentExpressionFadeIn() {},
          stopMotions() {
            surface.state.clearTracks();
          },
          canvasBounds() {
            return canvas;
          },
          drawableBounds() {
            return bounds();
          },
          primeInitialFrame(frame) {
            model.update(0, frame);
          },
          update(delta) {
            if (released) return;
            surface.update(paused || suspended ? 0 : Math.max(0, delta) * speed);
            updateSerial++;
          },
          createSnapshot() {
            return {
              skin: currentSkin,
              tracks: surface.state.tracks.flatMap((track, index) =>
                track && track.animation
                  ? [{ index, name: track.animation.name, time: track.trackTime, loop: track.loop }]
                  : [],
              ),
            };
          },
          restoreSnapshot(value) {
            const snapshot = value as {
              skin?: string;
              tracks?: { index: number; name: string; time: number; loop: boolean }[];
            };
            surface.state.clearTracks();
            if (snapshot.skin) model.playExpression(snapshot.skin);
            for (const track of snapshot.tracks ?? []) {
              if (data.findAnimation(track.name))
                surface.state.setAnimation(track.index, track.name, track.loop).trackTime = track.time;
            }
            surface.update(0);
          },
          draw(mvp, framebuffer, viewport) {
            if (released) return;
            const target = renderer.getRenderTarget(),
              autoClear = renderer.autoClear,
              sortObjects = renderer.sortObjects;
            const previousViewport = renderer.getViewport(new three.Vector4());
            const pixelRatio = renderer.getPixelRatio();
            try {
              renderer.resetState();
              renderer.autoClear = false;
              renderer.sortObjects = false;
              camera.projectionMatrix.copy(mvp);
              camera.projectionMatrixInverse.copy(mvp).invert();
              renderer.setViewport(
                viewport[0] / pixelRatio,
                viewport[1] / pixelRatio,
                viewport[2] / pixelRatio,
                viewport[3] / pixelRatio,
              );
              gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
              renderer.render(scene, camera);
              drawSerial++;
            } finally {
              renderer.resetState();
              renderer.autoClear = autoClear;
              renderer.sortObjects = sortObjects;
              renderer.setRenderTarget(target);
              renderer.setViewport(previousViewport);
            }
          },
          release() {
            if (released) return;
            released = true;
            surface.dispose();
            atlas!.dispose();
            bitmaps.forEach((bitmap) => bitmap.close());
          },
        };
        signal.throwIfAborted();
        return model;
      } catch (error) {
        mesh?.dispose();
        atlas?.dispose();
        bitmaps.forEach((bitmap) => bitmap.close());
        throw error;
      }
    },
  };
}
function relativeResource(parent: string, child: string): string {
  if (/^(?:[a-z][a-z\d+.-]*:|\/)/iu.test(parent)) return new URL(child, parent).href;
  return decodeURIComponent(new URL(child, new URL(parent, "https://spine.invalid/")).pathname.slice(1));
}
type Batcher = Three.Mesh & {
  clear(): unknown;
  findMaterialGroup(texture: Three.Texture, blend: unknown): number;
  newMaterial(): Three.Material & { map: Three.Texture | null };
  material: Three.Material[];
};
function preservePainterOrder(mesh: Spine.SkeletonMesh, spine: typeof Spine) {
  const owner = mesh as unknown as { nextBatch(): Batcher },
    next = owner.nextBatch.bind(mesh),
    configured = new WeakSet<Batcher>();
  owner.nextBatch = () => {
    const batch = next();
    if (configured.has(batch)) return batch;
    configured.add(batch);
    let cursor = 0;
    const clear = batch.clear.bind(batch);
    batch.clear = () => {
      cursor = 0;
      return clear();
    };
    batch.findMaterialGroup = (texture, blend) => {
      const index = cursor++,
        material =
          (batch.material[index] as (Three.Material & { map: Three.Texture | null }) | undefined) ??
          batch.newMaterial();
      batch.material[index] = material;
      material.map = texture;
      Object.assign(material, spine.ThreeJsTexture.toThreeJsBlending(blend as Spine.BlendMode));
      material.needsUpdate = true;
      return index;
    };
    return batch;
  };
}
