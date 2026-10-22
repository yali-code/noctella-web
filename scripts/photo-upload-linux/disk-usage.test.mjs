import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { usage } from "./disk-usage.mjs";

test("disk observer skips a SQLite -shm file unlinked between directory listing and lstat", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "noctella-observer-"));
  const keep = path.join(root, "photo.bin");
  const transient = path.join(root, "api.sqlite-shm");
  const original = fsp.lstat;
  try {
    await fsp.writeFile(keep, "safe");
    await fsp.writeFile(transient, "gone");
    fsp.lstat = async (...args) => {
      if (args[0] === transient) {
        const error = new Error("disappeared"); error.code = "ENOENT"; throw error;
      }
      return original(...args);
    };
    const result = await usage(root);
    assert.equal(result.files, 1);
    assert.equal(result.logical, 4);
  } finally {
    fsp.lstat = original;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("disk observer fails closed for unexpected filesystem errors and symlinks", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "noctella-observer-"));
  const file = path.join(root, "photo.bin");
  const original = fsp.lstat;
  try {
    await fsp.writeFile(file, "safe");
    fsp.lstat = async (...args) => {
      if (args[0] === file) {
        const error = new Error("denied"); error.code = "EACCES"; throw error;
      }
      return original(...args);
    };
    await assert.rejects(usage(root), { code: "EACCES" });
    fsp.lstat = original;
    await fsp.symlink(file, path.join(root, "unsafe-link"));
    await assert.rejects(usage(root), /Unexpected symlink/);
  } finally {
    fsp.lstat = original;
    await fsp.rm(root, { recursive: true, force: true });
  }
});
