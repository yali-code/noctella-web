/*
 * #472 F2 Contract 1 OFFLINE PROOF ONLY. OBSERVATIONAL link recorder, preloaded with --require.
 * It records every link attempt over IPC and then ALWAYS calls the real link immediately.
 * It never waits for a reply, never authorizes and never denies anything; validation is post hoc.
 */
"use strict";
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const { syncBuiltinESMExports } = require("node:module");

let seq = 0;
/** Shared per-actor sequence: the actor and this observer use one counter on one IPC channel. */
globalThis.__f2c1Emit = (kind, data) => {
  seq += 1;
  if (process.send) process.send({ type: "event", kind, seq, data });
  return seq;
};
const record = (src, dst) => globalThis.__f2c1Emit("LINK_ATTEMPT", { src: String(src), dst: String(dst) });

const realPromiseLink = fsPromises.link;
const observedPromiseLink = async (src, dst) => {
  record(src, dst);
  try { await realPromiseLink(src, dst); globalThis.__f2c1Emit("LINK_RESULT", { dst: String(dst), ok: true }); }
  catch (error) { globalThis.__f2c1Emit("LINK_RESULT", { dst: String(dst), ok: false, code: error && error.code }); throw error; }
};
fsPromises.link = observedPromiseLink;
if (fs.promises && fs.promises !== fsPromises) fs.promises.link = observedPromiseLink;

const realLinkSync = fs.linkSync;
fs.linkSync = (src, dst) => { record(src, dst); return realLinkSync(src, dst); };
const realLink = fs.link;
fs.link = (src, dst, callback) => { record(src, dst); return realLink(src, dst, callback); };

// ESM named imports of node:fs / node:fs/promises must observe the wrappers too.
syncBuiltinESMExports();
