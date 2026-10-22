/** Disposable synthetic ICC evidence only; no product/material fidelity or owner acceptance claim. */
import { it, expect } from "vitest";
import sharp from "sharp";
import { deflateSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareDeterministicProductPhotoFiles } from "../src/services/photoStorage";

function chunk(type: string, payload: Buffer) {
  const body = Buffer.concat([Buffer.from(type), payload]);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const prefix = Buffer.alloc(4), suffix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length); suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([prefix, body, suffix]);
}
// Assign an actual ICC profile to original RGB codes, without pre-converting them from sRGB.
function tagPng(png: Buffer, icc: Buffer) {
  const endIhdr = 8 + 12 + png.readUInt32BE(8);
  return Buffer.concat([png.subarray(0, endIhdr), chunk("iCCP", Buffer.concat([Buffer.from("synthetic\0\0"), deflateSync(icc)])), png.subarray(endIhdr)]);
}

it("records actual W4 conversion of tagged sRGB/P3 patches against explicit sRGB reference", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "noctella-w4-color-"));
  const evidence = process.env.NOCTELLA_W4_COLOR_EVIDENCE_DIR ? path.resolve(process.env.NOCTELLA_W4_COLOR_EVIDENCE_DIR) : path.join(tmp, "evidence");
  const width = 600, height = 120;
  const patches = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [220, 100, 40], [120, 90, 70], [128, 128, 128]];
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set(patches[Math.floor(x / 100)], (y * width + x) * 3);
  const png = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const rows: Array<{ input: Buffer; top: number }> = [];
  const metrics: any = { claim: "Synthetic profile conversion evidence only. No calibrated display, real-product fidelity, general Delta E or owner acceptance claim.", sharp: sharp.versions, patches, cases: [] };
  try {
    await mkdir(evidence, { recursive: true });
    for (const [index, profile] of ["srgb", "p3"].entries()) {
      const tagged = await sharp(png).withIccProfile(profile).png().toBuffer();
      const icc = (await sharp(tagged).metadata()).icc!;
      expect(icc.length).toBeGreaterThan(100);
      const input = tagPng(png, icc);
      expect((await sharp(input).metadata()).icc!.equals(icc)).toBe(true);
      const outputDir = path.join(tmp, profile); await mkdir(outputDir);
      const outputs = await prepareDeterministicProductPhotoFiles({ buffer: input, mimetype: "image/png", size: input.length }, outputDir);
      const record: any = { profile, inputIccBytes: icc.length, derivatives: [] };
      // Lossless independent color-managed reference, not the production recipe helper.
      const reference = await sharp(input).withIccProfile("srgb", { attach: false }).png().toBuffer();
      const rawReference = await sharp(reference).raw().toBuffer({ resolveWithObject: true });
      const sourceCenters = patches.map((_, i) => [...rawReference.data.subarray((60 * width + i * 100 + 50) * 3, (60 * width + i * 100 + 50) * 3 + 3)]);
      if (profile === "p3") expect(sourceCenters[3]).not.toEqual(patches[3]); // actual profile conversion, not just metadata removal
      for (const [name, file, size, quality] of [["main", outputs.main, 2000, 86], ["thumb", outputs.thumb, 400, 82]] as const) {
        const actual = await readFile(file), meta = await sharp(actual).metadata();
        expect(meta.icc).toBeUndefined(); expect(meta.exif).toBeUndefined(); expect(meta.xmp).toBeUndefined();
        const ref = await sharp(reference).resize({ width: size, height: size, fit: "inside", withoutEnlargement: true }).png().toBuffer();
        const a = await sharp(actual).raw().toBuffer({ resolveWithObject: true });
        const r = await sharp(ref).raw().toBuffer({ resolveWithObject: true });
        expect([a.info.width, a.info.height, a.info.channels]).toEqual([r.info.width, r.info.height, r.info.channels]);
        const samples = patches.map((_, i) => {
          const at = (Math.floor(a.info.height / 2) * a.info.width + Math.floor((i + 0.5) * a.info.width / patches.length)) * 3;
          const actualRgb = [...a.data.subarray(at, at + 3)], referenceRgb = [...r.data.subarray(at, at + 3)];
          return { actualRgb, referenceRgb, maxChannelDifference: Math.max(...actualRgb.map((v, c) => Math.abs(v - referenceRgb[c]))) };
        });
        // Patch centers avoid lossy WebP boundary ringing; this is not a general image-quality threshold.
        expect(Math.max(...samples.map(s => s.maxChannelDifference))).toBeLessThanOrEqual(8);
        record.derivatives.push({ name, quality, width: meta.width, height: meta.height, outputIcc: false, samples });
      }
      await writeFile(path.join(evidence, `${profile}-tagged-input.png`), input);
      await writeFile(path.join(evidence, `${profile}-srgb-reference.png`), reference);
      await writeFile(path.join(evidence, `${profile}-w4-main.webp`), await readFile(outputs.main));
      await writeFile(path.join(evidence, `${profile}-w4-thumb.webp`), await readFile(outputs.thumb));
      const label = `<svg width="600" height="30"><rect width="600" height="30" fill="white"/><text x="8" y="21" font-size="16">${profile}: explicit sRGB reference / actual W4 main</text></svg>`;
      const top = index * 270;
      rows.push({ input: Buffer.from(label), top }, { input: reference, top: top + 30 }, { input: await readFile(outputs.main), top: top + 150 });
      metrics.cases.push(record);
    }
    await sharp({ create: { width: 600, height: 540, channels: 3, background: "white" } }).composite(rows.map(r => ({ ...r, left: 0 }))).png().toFile(path.join(evidence, "comparison.png"));
    await writeFile(path.join(evidence, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
  } finally { await rm(tmp, { recursive: true, force: true }); }
}, 30000);
