'use strict';
// P2-2B3D2 (#407): physical disk inventory used by the disk-budget measurements.
// Counts every inode once (hardlinks share payload), reports logical bytes, POSIX
// allocated bytes (st_blocks * 512) when the platform exposes them, and a
// conservative cluster-rounded estimate otherwise. Directories are counted too.
const fs = require('node:fs');
const path = require('node:path');

function clusterBytes(root) {
  try { return Number(fs.statfsSync(root).bsize) || 4096; } catch { return 4096; }
}

function roundUp(bytes, cluster) {
  return bytes === 0 ? 0 : Math.ceil(bytes / cluster) * cluster;
}

/** Walks roots without following symlinks; never mutates anything. */
function inventory(roots, options = {}) {
  const cluster = options.cluster ?? clusterBytes(roots[0]);
  const skip = options.skip ?? (() => false);
  const inodes = new Map();
  const entries = [];
  let directories = 0, directoryAllocated = 0, symlinks = 0;
  function walk(dir) {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of list) {
      const file = path.join(dir, entry.name);
      if (skip(file)) continue;
      const stat = fs.lstatSync(file, { bigint: true });
      if (stat.isSymbolicLink()) { symlinks++; continue; }
      if (stat.isDirectory()) {
        directories++;
        directoryAllocated += stat.blocks !== undefined && stat.blocks !== null ? Number(stat.blocks) * 512 : 0;
        walk(file);
        continue;
      }
      if (!stat.isFile()) continue;
      const key = `${stat.dev}:${stat.ino}`;
      entries.push({ path: file, key, size: Number(stat.size), nlink: Number(stat.nlink) });
      if (!inodes.has(key)) {
        const blocks = stat.blocks !== undefined && stat.blocks !== null && process.platform !== 'win32' ? Number(stat.blocks) * 512 : null;
        inodes.set(key, { size: Number(stat.size), allocated: blocks, rounded: roundUp(Number(stat.size), cluster), zeroByte: stat.size === 0n });
      }
    }
  }
  for (const root of roots) walk(root);
  const unique = [...inodes.values()];
  const sum = (pick) => unique.reduce((total, item) => total + pick(item), 0);
  const posixAllocated = unique.every((item) => item.allocated !== null) ? sum((item) => item.allocated) : null;
  return {
    cluster,
    paths: entries.length,
    inodes: unique.length,
    zeroByteInodes: unique.filter((item) => item.zeroByte).length,
    directories,
    symlinks,
    logicalBytesPerPath: entries.reduce((total, item) => total + item.size, 0),
    logicalBytes: sum((item) => item.size),
    clusterRoundedBytes: sum((item) => item.rounded),
    posixAllocatedBytes: posixAllocated,
    directoryAllocatedBytes: directoryAllocated,
    /** Allocated when known, otherwise the cluster-rounded estimate. */
    conservativeBytes: (posixAllocated ?? sum((item) => item.rounded)) + directoryAllocated,
  };
}

module.exports = { inventory, clusterBytes, roundUp };
