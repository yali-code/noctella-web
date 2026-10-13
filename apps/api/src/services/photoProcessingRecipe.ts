import sharp from "sharp";

export function productPhotoImage(input: Buffer | string, options: sharp.SharpOptions = {}) {
  return sharp(input, { failOn: "error", ...options }).rotate();
}
/** Both entry points share the established recipe; no AI-intake byte/quality change. */
export function productPhotoDerivative(image: sharp.Sharp, thumbnail = false) {
  const size = thumbnail ? 400 : 2000;
  return image.clone().resize({ width: size, height: size, fit: "inside", withoutEnlargement: true }).webp({ quality: thumbnail ? 82 : 86 });
}
