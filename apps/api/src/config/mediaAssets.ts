import path from "node:path";

/**
 * Durable media assets (rendered Reels). Production: MEDIA_ASSET_DIR=/var/data/media-assets on the
 * persistent disk, so already-scheduled Reels survive restarts. Binary video is never stored in SQLite.
 * File names are generated (reel-<plan item uuid>.mp4), never user-controlled; the public path exposes
 * only that safe name, never a filesystem path.
 */
export const REEL_PUBLIC_PATH = "/media/reels";
export const REEL_FILE_NAME = /^reel-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4$/;

export function mediaAssetDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.MEDIA_ASSET_DIR?.trim() || path.resolve(process.cwd(), "uploads/media-assets"));
}

export function reelFileName(itemId: string): string {
  const name = `reel-${itemId}.mp4`;
  if (!REEL_FILE_NAME.test(name)) throw new Error("Invalid Reel asset identifier");
  return name;
}

/** Absolute file path for a safe Reel file name inside MEDIA_ASSET_DIR, or null (rejects traversal and foreign names). */
export function reelFilePath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!REEL_FILE_NAME.test(name)) return null;
  const root = mediaAssetDir(env);
  const file = path.resolve(root, name);
  return file.startsWith(root + path.sep) ? file : null;
}

/** "/media/reels/<name>" -> safe file name, or null. */
export function reelNameFromPublicPath(publicPath: string): string | null {
  if (!publicPath.startsWith(`${REEL_PUBLIC_PATH}/`)) return null;
  const name = publicPath.slice(REEL_PUBLIC_PATH.length + 1);
  return REEL_FILE_NAME.test(name) ? name : null;
}
