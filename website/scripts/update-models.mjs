// Freezes the live model catalog into `src/models/snapshot.json`, the file the
// model catalog page reads. The site's security policy only lets the page talk
// to its own origin, so the catalog is captured at build time, never fetched
// by the reader's browser.
//
//   node website/scripts/update-models.mjs
//
// Every endpoint used is public except the video quote, which is free and
// charges nothing: set CARPE_DIEM_API_KEY to refresh video prices, otherwise
// the previous snapshot's video prices are kept.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const operator = "https://carpe-diem.xyz/api/operator";
const venice = "https://api.venice.ai/api/v1/models?type=all";
const output = fileURLToPath(new URL("../src/models/snapshot.json", import.meta.url));
const videoTypes = new Set(["video", "imageToVideo", "referenceToVideo"]);

const json = async (url, init) => {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
};

const previous = await readFile(output, "utf8")
  .then((text) => JSON.parse(text))
  .catch(() => ({ models: [] }));
const previousVideo = new Map(
  previous.models
    .filter((model) => model.usdPerSecond)
    .map((model) => [model.id, model.usdPerSecond]),
);

const [catalog, pricing, upstream] = await Promise.all([
  json(`${operator}/v1/models`),
  json(`${operator}/pricing`),
  json(venice),
]);
const names = new Map(upstream.data.map((model) => [model.id, model.model_spec ?? {}]));
const tokenPrices = new Map(pricing.models.map((row) => [row.model, row]));
const fixedPrices = new Map(pricing.fixedCost.map((row) => [row.model, row]));

const round = (value) => Math.round(value * 100000) / 100000;
const seconds = (value) => {
  const parsed = Number.parseFloat(String(value).replace(/s$/, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

// A 512 px flat image: enough for a quote to validate an image-led request.
const pixel = await (async () => {
  const { deflateSync, crc32 } = await import("node:zlib");
  const size = 512;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x80)]);
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
})();

async function quote(model) {
  const key = process.env.CARPE_DIEM_API_KEY;
  if (!key) return previousVideo.get(model.id) ?? null;
  const durations = (model.constraints?.durations ?? ["5s"]).filter((value) => seconds(value));
  if (!durations.length) return previousVideo.get(model.id) ?? null;
  const duration = durations.reduce((best, value) =>
    Math.abs(seconds(value) - 5) < Math.abs(seconds(best) - 5) ? value : best,
  );
  const body = { model: model.id, prompt: "A quiet harbour at dawn, slow camera move", duration };
  if (model.carpe_diem_type !== "video") body.image_url = pixel;
  if (model.carpe_diem_type === "referenceToVideo") body.reference_image_urls = [pixel];
  try {
    const answer = await json(`${operator}/v1/video/quote`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return typeof answer.quote === "number"
      ? Math.round((answer.quote / seconds(duration)) * 10000) / 10000
      : (previousVideo.get(model.id) ?? null);
  } catch {
    return previousVideo.get(model.id) ?? null;
  }
}

const models = [];
for (const model of catalog.data) {
  const spec = names.get(model.id) ?? {};
  const capabilities = model.capabilities ?? {};
  const constraints = model.constraints ?? {};
  const durations = (constraints.durations ?? []).map(seconds).filter((value) => value !== null);
  const tokens = tokenPrices.get(model.id);
  const fixed = fixedPrices.get(model.id);
  const entry = {
    id: model.id,
    type: model.carpe_diem_type,
    tier: model.tier,
    privacy: model.privacy,
    name: spec.name ?? null,
  };
  if (model.context_length) entry.context = model.context_length;
  const traits = [
    capabilities.supportsVision && "vision",
    capabilities.supportsFunctionCalling && "tools",
    capabilities.supportsReasoning && "reasoning",
    capabilities.optimizedForCode && "code",
    capabilities.supportsWebSearch && "web",
  ].filter(Boolean);
  if (traits.length) entry.traits = traits;
  if (durations.length) entry.seconds = [Math.min(...durations), Math.max(...durations)];
  if (constraints.audio) entry.audio = true;
  if (constraints.resolutions?.length) entry.resolutions = constraints.resolutions;
  if (model.carpe_diem_type === "text" && tokens?.outputPrice !== undefined)
    entry.usdPerMillion = [tokens.inputPrice, tokens.outputPrice];
  // Audio rows reuse the token table's input column for a per-unit price; the
  // unit is the provider's, scaled by the operator's multiplier.
  const scale = tokens?.multiplier ?? pricing.models[0]?.multiplier ?? 1;
  const list = spec.pricing ?? {};
  if (model.carpe_diem_type === "tts" && tokens) entry.usdPerMillionCharacters = tokens.inputPrice;
  if (model.carpe_diem_type === "asr" && tokens) entry.usdPerMinute = tokens.inputPrice;
  if (model.carpe_diem_type === "music") {
    if (list.per_second) entry.usdPerAudioSecond = round(list.per_second.usd * scale);
    else if (list.generation) entry.usdPerTrack = round(list.generation.usd * scale);
    else if (list.durations?.["60"])
      entry.usdPerMinuteOfMusic = round(list.durations["60"].usd * scale);
  }
  if (model.carpe_diem_type === "upscale" && list.upscale?.["2x"])
    entry.usdPerUpscale = round(list.upscale["2x"].usd * scale);
  if (fixed) entry.credits = fixed.costCredits;
  if (videoTypes.has(model.carpe_diem_type)) {
    const perSecond = await quote(model);
    if (perSecond) entry.usdPerSecond = perSecond;
  }
  models.push(entry);
}
models.sort((a, b) => a.id.localeCompare(b.id));

const snapshot = { checkedAt: new Date().toISOString().slice(0, 10), models };
await writeFile(output, `${JSON.stringify(snapshot, null, 1)}\n`);
console.log(`${models.length} models written to ${output}`);
