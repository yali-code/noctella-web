import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExifTiff, insertExifApp1, psnr, ssimLuma, scanMarkers } from "./w3-fidelity-lib.mjs";

test("#390 synthetic EXIF fixture carries orientation, serial and GPS markers in a valid TIFF layout", () => {
  const tiff = buildExifTiff({ make: "SyntheticCam", orientation: 6, serial: "SERIAL-390-TEST", datum: "GPS-390-DATUM" });
  assert.equal(tiff.toString("latin1", 0, 2), "II"); assert.equal(tiff.readUInt16LE(2), 42); assert.equal(tiff.readUInt32LE(4), 8);
  const entries = tiff.readUInt16LE(8), tags = Array.from({ length: entries }, (_, i) => tiff.readUInt16LE(10 + i * 12));
  assert.deepEqual(tags, [0x010f, 0x0112, 0x8769, 0x8825]);
  assert.equal(tiff.readUInt16LE(10 + 12 + 8), 6);
  const gpsAt = tiff.readUInt32LE(10 + 3 * 12 + 8);
  assert.equal(tiff.readUInt16LE(gpsAt + 2), 0x0000);
  assert.deepEqual(scanMarkers(tiff, ["SERIAL-390-TEST", "GPS-390-DATUM", "SyntheticCam", "absent"]), ["SERIAL-390-TEST", "GPS-390-DATUM", "SyntheticCam"]);
  const jpeg = insertExifApp1(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), tiff);
  assert.deepEqual([...jpeg.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xe1]);
  assert.equal(jpeg.readUInt16BE(4), 2 + 6 + tiff.length);
  assert.throws(() => insertExifApp1(Buffer.from([0, 1]), tiff));
});

test("#390 PSNR and luma SSIM behave at identity and under a small change", () => {
  const a = Buffer.alloc(32 * 16 * 3); for (let i = 0; i < a.length; i++) a[i] = (i * 37) & 255;
  const b = Buffer.from(a); b[100] ^= 8;
  assert.equal(psnr(a, a), Infinity); assert.ok(psnr(a, b) > 40 && Number.isFinite(psnr(a, b)));
  assert.equal(ssimLuma(a, a, 32, 16, 3), 1); assert.ok(ssimLuma(a, b, 32, 16, 3) < 1);
  assert.throws(() => psnr(a, a.subarray(1)));
});
