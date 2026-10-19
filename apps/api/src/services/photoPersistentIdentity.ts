import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { photoPreparationConfinementConfig } from "./photoPreparationConfinement";

// Versioned evidence in the existing TEXT identity columns. Numeric legacy values are NEVER upgraded in place.
// UUID is kernel-reported through the very same open descriptor; birth time also protects source inode reuse.
const TOKEN = /^pfs1:([0-9a-f]{32}):([1-9][0-9]{0,19})$/;
export const persistentStorageId = (value: string) => TOKEN.exec(value)?.[1] ?? null;

export function persistentPhotoDevice(fd: number, stat: fs.BigIntStats, env: NodeJS.ProcessEnv = process.env): string {
  const config = photoPreparationConfinementConfig(env);
  if (config.mode !== "confined" || stat.birthtimeNs <= 0n) throw new Error("PHOTO_PERSISTENT_IDENTITY_UNAVAILABLE");
  const result = spawnSync(config.launcher, ["--storage-proof"], {
    stdio: ["ignore", "pipe", "pipe", fd], encoding: "utf8", timeout: 5000, maxBuffer: 1024,
    env: { PATH: process.env.PATH },
  });
  const uuid = result.stdout?.trim();
  if (result.error || result.status !== 0 || !/^[0-9a-f]{32}$/.test(uuid ?? "") || /^0+$/.test(uuid))
    throw new Error("PHOTO_PERSISTENT_IDENTITY_UNAVAILABLE");
  const after = fs.fstatSync(fd, { bigint: true });
  if (after.dev !== stat.dev || after.ino !== stat.ino || after.birthtimeNs !== stat.birthtimeNs)
    throw new Error("PHOTO_PERSISTENT_IDENTITY_CHANGED");
  return `pfs1:${uuid}:${stat.birthtimeNs}`;
}

export function sealedPhotoDevice(fd: number, stat: fs.BigIntStats): string {
  const config = photoPreparationConfinementConfig();
  if (config.mode === "invalid") throw new Error("PHOTO_PERSISTENT_IDENTITY_UNAVAILABLE");
  return config.mode === "confined" ? persistentPhotoDevice(fd, stat) : String(stat.dev);
}

export function matchesPhotoDevice(fd: number, stat: fs.BigIntStats, expected: string): boolean {
  if (/^[0-9]+$/.test(expected)) return String(stat.dev) === expected; // strict legacy same-device policy
  if (!TOKEN.test(expected)) return false;
  return persistentPhotoDevice(fd, stat) === expected;
}

/** Verify the trusted destination filesystem before any staging mutation. Not a path/env-label attestation. */
export function assertPublicationStorage(dir: string, expected: string): void {
  if (!persistentStorageId(expected)) {
    if (!/^[0-9]+$/.test(expected)) throw new Error("PHOTO_PERSISTENT_IDENTITY_INVALID");
    return;
  }
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isDirectory() || persistentStorageId(persistentPhotoDevice(fd, st)) !== persistentStorageId(expected))
      throw new Error("PHOTO_PERSISTENT_STORAGE_MISMATCH");
  } finally { fs.closeSync(fd); }
}
