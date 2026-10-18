/**
 * #472 F2 Step 4 OFFLINE preparation worker, started CONFINED by the Step 2 launcher (plain mode, allowlist: the
 * operation's generation directory and its own tmp). Runs the REAL W2/W4 preparation function, then keeps the
 * authority a stale or compromised worker retains: a read/write descriptor to its source and a hardlink alias.
 */
import fs from "node:fs";

async function main() {
  const { stagedProductPhotoStorage } = await import("../../src/services/stagedProductPhotoStorage");
  const { prepareDeterministicProductPhotoFiles } = await import("../../src/services/photoStorage");
  let retained = -1;
  const attempt = (fn: () => unknown) => { try { const v = fn(); return v === undefined ? "OK" : v; } catch (e: any) { return e?.code ?? "ERR"; } };
  const handlers: Record<string, (a: any) => Promise<unknown> | unknown> = {
    async prepare(a) {
      const bytes = fs.readFileSync(a.input);
      return a.kind === "w2"
        ? stagedProductPhotoStorage.prepareFencedProductPhoto({ path: a.input, workDir: a.workDir, size: bytes.length, mimetype: "image/jpeg", signal: new AbortController().signal } as any, a.genDir)
        : prepareDeterministicProductPhotoFiles({ buffer: bytes, mimetype: "image/jpeg", size: bytes.length }, a.genDir);
    },
    retain: (a) => attempt(() => { retained = fs.openSync(a.path, "r+"); return retained; }),
    alias: (a) => attempt(() => fs.linkSync(a.from, a.to)),
    writeRetained: (a) => attempt(() => { fs.writeSync(retained, Buffer.from(a.content), 0, Buffer.byteLength(a.content), a.offset); }),
    writeAt: (a) => attempt(() => { const fd = fs.openSync(a.path, "r+"); try { fs.writeSync(fd, Buffer.from(a.content), 0, Buffer.byteLength(a.content), a.offset); } finally { fs.closeSync(fd); } }),
    openWrite: (a) => attempt(() => fs.closeSync(fs.openSync(a.path, "r+"))),
  };
  process.on("message", async (m: any) => {
    if (m?.type !== "cmd") return;
    try { process.send?.({ type: "reply", id: m.id, ok: true, result: await handlers[m.cmd](m.args ?? {}) }); }
    catch (error: any) { process.send?.({ type: "reply", id: m.id, ok: false, error: String(error?.message ?? error) }); }
  });
  process.send?.({ type: "ready", pid: process.pid });
}
main().catch((error) => { process.send?.({ type: "fatal", error: String(error?.message ?? error) }); process.exitCode = 2; });
