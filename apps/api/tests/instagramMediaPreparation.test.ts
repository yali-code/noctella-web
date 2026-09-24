import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import * as files from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareInstagramImage } from "../src/integrations/instagram/mediaPreparation";
import * as preparation from "../src/integrations/instagram/mediaPreparation";
import { InstagramPublishingAdapter } from "../src/integrations/instagram/publishingAdapter";
import { InstagramClient } from "../src/integrations/instagram/InstagramClient";
import { INSTAGRAM_VAULT_ACCOUNT_ID } from "../src/integrations/instagram/types";
import { validateInstagramMediaUrl } from "../src/config/instagramConfig";

// Keep real filesystem operations, with configurable exports for deterministic race injection.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
}));

const origin = "https://api.staging.noctella.com";
const env = { INSTAGRAM_MEDIA_ALLOWED_HOSTS: "api.staging.noctella.com" };
const photo = { url: "/images/product-photos/canonical.webp" };
let root: string;
let source: Buffer;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "noctella-instagram-test-"));
  source = await sharp({ create: { width: 800, height: 400, channels: 3, background: "#ff0000" } }).webp().toBuffer();
  await writeFile(path.join(root, "canonical.webp"), source);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("noctella-instagram-test-")) throw new Error("Unsafe test cleanup");
  await rm(root, { recursive: true, force: true });
});

describe("Instagram local canonical media preparation", () => {
  it("produces a real JPEG at the approved public path without stretching or changing the source", async () => {
    const url = await prepareInstagramImage(photo, origin, env, root);
    expect(url).toMatch(/^https:\/\/api\.staging\.noctella\.com\/images\/product-photos\/instagram-v1-[a-f0-9]{64}\.jpg$/);
    expect(validateInstagramMediaUrl(url, env)).toBe(url);
    const bytes = await readFile(path.join(root, path.basename(url)));
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(await sharp(bytes).metadata()).toMatchObject({ format: "jpeg", width: 1080, height: 1080, space: "srgb" });
    const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    // The 2:1 red source remains 1080x540, centered between white padding.
    const redRows: number[] = [];
    for (let y = 0; y < info.height; y++) {
      const offset = (y * info.width + 540) * info.channels;
      if (data[offset] > 200 && data[offset + 1] < 50) redRows.push(y);
    }
    expect(redRows.length).toBeGreaterThanOrEqual(538);
    expect(redRows.length).toBeLessThanOrEqual(542);
    expect(redRows[0]).toBeGreaterThanOrEqual(269);
    expect(await readFile(path.join(root, "canonical.webp"))).toEqual(source);
    expect(bytes.length).toBeLessThan(8 * 1024 * 1024);
  });

  it("reuses a deterministic derivative on repeat and concurrent preparation without rewriting", async () => {
    const urls = await Promise.all([1, 2, 3].map(() => prepareInstagramImage(photo, origin, env, root)));
    expect(new Set(urls).size).toBe(1);
    const file = path.join(root, path.basename(urls[0]));
    const before = await stat(file);
    const bytes = await readFile(file);
    expect(await prepareInstagramImage(photo, origin, env, root)).toBe(urls[0]);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(file)).toEqual(bytes);
    expect((await readdir(root)).sort()).toEqual(["canonical.webp", path.basename(file)].sort());
  });

  it("uses a different derivative for changed source bytes", async () => {
    const first = await prepareInstagramImage(photo, origin, env, root);
    await writeFile(path.join(root, "canonical.webp"), await sharp(source).flip().tint("blue").webp().toBuffer());
    expect(await prepareInstagramImage(photo, origin, env, root)).not.toBe(first);
  });

  it.each([
    "/images/product-photos/../canonical.webp",
    "/images/product-photos/sub/canonical.webp",
    "/images/product-photos/%2e%2e/canonical.webp",
    "/images/product-photos/sub\\canonical.webp",
    "https://external.test/canonical.webp",
    "file:///canonical.webp",
    "/images/other/canonical.webp",
    "/images/product-photos/canonical.webp?token=secret",
  ])("rejects non-local/non-canonical or traversal reference %s", async (url) => {
    await expect(prepareInstagramImage({ url }, origin, env, root)).rejects.toMatchObject({ kind: "invalid_media", message: "Instagram invalid media error" });
    expect(await readdir(root)).toEqual(["canonical.webp"]);
  });

  it("fails safely for missing source and never leaks paths or supplied credentials", async () => {
    for (const [reference, publicOrigin] of [
      [{ url: "/images/product-photos/missing.webp" }, origin],
      [photo, "https://user:secret@api.staging.noctella.com"],
      [photo, "https://unapproved.example.test"],
    ] as const) {
      try { await prepareInstagramImage(reference, publicOrigin, env, root); expect.fail("Expected rejection"); }
      catch (error: any) {
        expect(error.message).toBe("Instagram invalid media error");
        expect(JSON.stringify(error)).not.toContain(root);
        expect(JSON.stringify(error)).not.toContain("secret");
      }
    }
  });

  it("rejects non-WebP bytes and corrupt cached derivatives without overwriting", async () => {
    const url = await prepareInstagramImage(photo, origin, env, root);
    const file = path.join(root, path.basename(url));
    await writeFile(file, "incomplete");
    await expect(prepareInstagramImage(photo, origin, env, root)).rejects.toMatchObject({ kind: "invalid_media" });
    expect(await readFile(file, "utf8")).toBe("incomplete");
    await writeFile(path.join(root, "canonical.webp"), await sharp(source).png().toBuffer());
    await expect(prepareInstagramImage(photo, origin, env, root)).rejects.toMatchObject({ kind: "invalid_media" });
  });

  it("automatically passes the prepared URL to the publisher for canonical WebP", async () => {
    const prepared = await prepareInstagramImage(photo, origin, env, root);
    const prepare = vi.spyOn(preparation, "prepareInstagramImage").mockResolvedValue(prepared);
    const create = vi.spyOn(InstagramClient.prototype, "createImageContainer").mockResolvedValue("container");
    const transport = vi.fn();
    const client = new InstagramClient("test-only-token", transport, { ...env, INSTAGRAM_API_VERSION: "v24.0" });
    const adapter = new InstagramPublishingAdapter(client, async () => undefined, env);
    expect(await adapter.createImageContainer(INSTAGRAM_VAULT_ACCOUNT_ID, `${origin}${photo.url}`, "Caption")).toBe("container");
    expect(prepare).toHaveBeenCalledWith(photo, origin, env);
    expect(create).toHaveBeenCalledExactlyOnceWith(INSTAGRAM_VAULT_ACCOUNT_ID, prepared, "Caption");
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["sub/../canonical.webp", "../../canonical.webp"])("rejects raw traversal %s before URL normalization hides it", async (suffix) => {
    const transport = vi.fn();
    const client = new InstagramClient("test-only-token", transport, { ...env, INSTAGRAM_API_VERSION: "v24.0" });
    const adapter = new InstagramPublishingAdapter(client, async () => undefined, env);
    await expect(adapter.createImageContainer(INSTAGRAM_VAULT_ACCOUNT_ID, `${origin}/images/product-photos/${suffix}`, "Caption"))
      .rejects.toMatchObject({ kind: "invalid_media" });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["source", "destination"])("rejects a %s inode swapped between validation and open", async (target) => {
    const prepared = await prepareInstagramImage(photo, origin, env, root);
    const filename = target === "source" ? "canonical.webp" : path.basename(prepared);
    const file = path.join(root, filename);
    const bytes = await readFile(file);
    const originalOpen = files.open;
    const openSpy = vi.spyOn(files, "open").mockImplementation(async (...args) => {
      if (String(args[0]) === file) {
        await files.rename(file, path.join(root, "swapped-backup"));
        await writeFile(file, bytes);
      }
      return originalOpen(...args);
    });
    await expect(prepareInstagramImage(photo, origin, env, root)).rejects.toMatchObject({ kind: "invalid_media" });
    expect(openSpy).toHaveBeenCalled();
    expect(await readFile(file)).toEqual(bytes);
  });

  it.each(["source", "destination"])("rejects a %s reported as a symbolic link", async (target) => {
    const prepared = await prepareInstagramImage(photo, origin, env, root);
    const filename = target === "source" ? "canonical.webp" : path.basename(prepared);
    const file = path.join(root, filename);
    const originalLstat = files.lstat;
    vi.spyOn(files, "lstat").mockImplementation(async (...args) => {
      const info = await originalLstat(...args);
      if (String(args[0]) === file) info.isSymbolicLink = () => true;
      return info;
    });
    await expect(prepareInstagramImage(photo, origin, env, root)).rejects.toMatchObject({ kind: "invalid_media" });
  });
});
