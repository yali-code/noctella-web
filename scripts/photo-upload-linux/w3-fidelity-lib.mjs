// #390 EXPERIMENT helpers (pure, synthetic data only): EXIF/GPS fixture construction and image comparison metrics.

/** Little-endian TIFF/EXIF with IFD0 (Make, Orientation), Exif IFD (BodySerialNumber) and GPS IFD (position + MapDatum marker). */
export function buildExifTiff({ make, orientation, serial, datum, lat = [52, 31, 12], lon = [13, 24, 36] }) {
  const ascii = s => Buffer.from(s + "\0", "latin1");
  const rationals = values => { const b = Buffer.alloc(values.length * 8); values.forEach((v, i) => { b.writeUInt32LE(v, i * 8); b.writeUInt32LE(1, i * 8 + 4); }); return b; };
  const short = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const long = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const entry = (tag, type, count, value) => ({ tag, type, count, value });
  const size = entries => 2 + entries.length * 12 + 4 + entries.reduce((n, e) => n + (e.value.length > 4 ? e.value.length + (e.value.length % 2) : 0), 0);
  const gps = [entry(0x0000, 1, 4, Buffer.from([2, 3, 0, 0])), entry(0x0001, 2, 2, ascii("N")), entry(0x0002, 5, 3, rationals(lat)), entry(0x0003, 2, 2, ascii("E")), entry(0x0004, 5, 3, rationals(lon)), entry(0x0012, 2, datum.length + 1, ascii(datum))];
  const exif = [entry(0xa431, 2, serial.length + 1, ascii(serial))];
  const ifd0 = [entry(0x010f, 2, make.length + 1, ascii(make)), entry(0x0112, 3, 1, short(orientation)), entry(0x8769, 4, 1, long(0)), entry(0x8825, 4, 1, long(0))];
  const ifd0At = 8, exifAt = ifd0At + size(ifd0), gpsAt = exifAt + size(exif);
  ifd0[2].value = long(exifAt); ifd0[3].value = long(gpsAt);
  const out = Buffer.alloc(gpsAt + size(gps));
  out.write("II", 0, "latin1"); out.writeUInt16LE(42, 2); out.writeUInt32LE(ifd0At, 4);
  const writeIfd = (entries, at) => {
    out.writeUInt16LE(entries.length, at);
    let data = at + 2 + entries.length * 12 + 4;
    entries.forEach((e, i) => {
      const p = at + 2 + i * 12;
      out.writeUInt16LE(e.tag, p); out.writeUInt16LE(e.type, p + 2); out.writeUInt32LE(e.count, p + 4);
      if (e.value.length <= 4) e.value.copy(out, p + 8);
      else { out.writeUInt32LE(data, p + 8); e.value.copy(out, data); data += e.value.length + (e.value.length % 2); }
    });
    out.writeUInt32LE(0, at + 2 + entries.length * 12);
  };
  writeIfd(ifd0, ifd0At); writeIfd(exif, exifAt); writeIfd(gps, gpsAt);
  return out;
}

/** Inserts an APP1 Exif segment directly after the JPEG SOI marker. */
export function insertExifApp1(jpeg, tiff) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw Error("Not a JPEG");
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(2 + 6 + tiff.length, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, Buffer.from("Exif\0\0", "latin1"), tiff, jpeg.subarray(2)]);
}

/** PSNR in dB over equally sized interleaved 8-bit buffers (Infinity when identical). */
export function psnr(a, b) {
  if (a.length !== b.length) throw Error("PSNR size mismatch");
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  return sum === 0 ? Infinity : 10 * Math.log10((255 * 255) / (sum / a.length));
}

/** Mean SSIM of BT.601 luma over non-overlapping 8x8 windows (8-bit, C1=(0.01*255)^2, C2=(0.03*255)^2). */
export function ssimLuma(a, b, width, height, channels) {
  if (a.length !== b.length || a.length !== width * height * channels) throw Error("SSIM size mismatch");
  const luma = (buf, i) => 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2];
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  let total = 0, windows = 0;
  for (let y = 0; y + 8 <= height; y += 8) for (let x = 0; x + 8 <= width; x += 8) {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 8; dx++) {
      const i = ((y + dy) * width + x + dx) * channels, va = luma(a, i), vb = luma(b, i);
      sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
    }
    const n = 64, ma = sa / n, mb = sb / n, va = saa / n - ma * ma, vb = sbb / n - mb * mb, cov = sab / n - ma * mb;
    total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
    windows++;
  }
  return total / windows;
}

/** Which of the synthetic privacy markers appear anywhere in the bytes. */
export const scanMarkers = (bytes, markers) => markers.filter(m => bytes.includes(Buffer.from(m, "latin1")));
