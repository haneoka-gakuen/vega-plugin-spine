const normalizePath = (path) =>
  String(path).replaceAll("\\", "/").replace(/^\.\/+/u, "");

const restrictedDirectory =
  /^(?:assets?|atlases?|character-models?|core|cubism(?:-?sdk)?|examples?|expressions?|framework|game-assets?|live2d|models?|motions?|physics|poses?|runtime|samples?|sdk|skeletons?|spine(?:-runtimes?)?|textures?|userdata|vendor)$/iu;

const cubismAssetName =
  /(?:^|[._-])(?:cdi3|exp(?:3)?|model(?:3)?|motion(?:3)?|motionsync3|physics(?:3)?|pose(?:3)?|userdata3)\.json$/iu;

const spineAssetName =
  /\.(?:atlas(?:\.(?:json|txt))?|skel|skeleton\.json|spine(?:\.json)?|spineproj)$/iu;

const restrictedExtension =
  /\.(?:bin|dat|dll|dylib|exp|gz|moc3?|mtn|node|so|tar|tgz|wasm|zip)$/iu;

const mediaExtension =
  /\.(?:avif|bmp|gif|jpe?g|m4a|mp3|mp4|ogg|png|svg|wav|webm|webp)$/iu;

const sdkFileName =
  /^(?:spine(?:-core|-canvas|-player|-threejs|-webgl)?(?:\.min)?|spine-cpp)\.(?:c|cc|cpp|h|hpp|js|mjs|cjs|wasm)$/iu;

const esotericCopyright =
  /copyright\s*(?:(?:\(\s*c\s*\)|©)\s*)?(?:(?:19|20)\d{2}(?:\s*[-–—,]\s*(?:19|20)\d{2})?\s*)?esoteric\s+software(?:\s+llc)?/iu;

const spineLicense =
  /spine\s+(?:editor|runtimes?|software)\s+license\s+agreement|esotericsoftware\.com\/spine-runtimes-license/iu;

const bundledRuntimeMarker =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']@esotericsoftware\/spine-[^"']+["']|\bcom\.esotericsoftware\.spine\b|#\s*include\s*[<"]spine\/spine\.h[>"]/iu;

const looksLikeSpineSkeletonJson = (text) =>
  /"skeleton"\s*:\s*\{/iu.test(text) &&
  /"spine"\s*:\s*"\d+\.\d+/iu.test(text) &&
  /"(?:animations|bones|skins|slots)"\s*:/iu.test(text);

const looksLikeSpineAtlas = (text) => {
  const atlasFields = [
    /(?:^|\r?\n)\s*size\s*:\s*\d+\s*,\s*\d+/iu,
    /(?:^|\r?\n)\s*filter\s*:\s*[^,\r\n]+\s*,\s*[^\r\n]+/iu,
    /(?:^|\r?\n)\s*repeat\s*:\s*(?:none|x|xy|y)/iu,
    /(?:^|\r?\n)\s*pma\s*:\s*(?:false|true)/iu,
  ].filter((pattern) => pattern.test(text)).length;
  const regionField =
    /(?:^|\r?\n)\s*(?:bounds|offsets|rotate|xy)\s*:/iu.test(text);
  return atlasFields >= 3 && regionField;
};

export const restrictedSpinePathReason = (path) => {
  const normalized = normalizePath(path);
  const segments = normalized.split("/").filter(Boolean);
  const basename = segments.at(-1) ?? "";

  if (segments.slice(0, -1).some((segment) => restrictedDirectory.test(segment))) {
    return "restricted SDK, runtime, model, or asset directory";
  }
  if (
    spineAssetName.test(basename) ||
    cubismAssetName.test(basename) ||
    restrictedExtension.test(basename) ||
    sdkFileName.test(basename)
  ) {
    return "Spine SDK, runtime, skeleton, atlas, or project filename";
  }
  if (mediaExtension.test(basename)) return "media or texture payload";
  return null;
};

export const restrictedSpineContentReason = (bytes) => {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (
    body.some(
      (byte) =>
        byte === 0 ||
        byte === 0x7f ||
        byte < 0x09 ||
        (byte > 0x0d && byte < 0x20),
    )
  ) {
    return "binary payload";
  }

  let text;
  try {
    text = utf8.decode(body).normalize("NFKC");
  } catch {
    return "binary payload";
  }
  if (esotericCopyright.test(text)) {
    return "Esoteric Software copyright signature";
  }
  if (spineLicense.test(text)) return "Spine license signature";
  if (bundledRuntimeMarker.test(text)) return "Spine SDK/runtime signature";
  if (looksLikeSpineSkeletonJson(text)) return "Spine skeleton JSON signature";
  if (looksLikeSpineAtlas(text)) return "Spine atlas signature";
  return null;
};
import { TextDecoder } from "node:util";

const utf8 = new TextDecoder("utf-8", { fatal: true });
