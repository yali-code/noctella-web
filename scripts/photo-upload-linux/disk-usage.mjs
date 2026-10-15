import fsp from "node:fs/promises";
import path from "node:path";

export async function usage(root) {
  let logical = 0, allocated = 0, files = 0;
  // SQLite may unlink -shm/-wal files between readdir and lstat.
  // Ignore only ENOENT races in the disposable observer; retain all other failures.
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error.code === "ENOENT") return { logical, allocated, files };
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const child = await usage(target); logical += child.logical; allocated += child.allocated; files += child.files;
    } else {
      let s;
      try { s = await fsp.lstat(target); }
      catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (s.isSymbolicLink()) throw Error("Unexpected symlink in disposable work directory");
      logical += s.size; allocated += s.blocks * 512; files++;
    }
  }
  return { logical, allocated, files };
}
