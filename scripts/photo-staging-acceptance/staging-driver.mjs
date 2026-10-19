// Stage 5 F2 closure Stage 1 — STAGING-ONLY acceptance driver for the real HTTP entry points (W2 upload, W4 finalize).
// Runs from an operator machine (Node >= 20, no dependencies) against a DISPOSABLE staging API. Never point it at
// production: it refuses unless F2_STAGING_CONFIRM_HOST equals the API host.
//
//   F2_STAGING_API=https://<staging-host> F2_STAGING_CONFIRM_HOST=<staging-host> \
//   F2_STAGING_EMAIL=<staging admin> F2_STAGING_PASSWORD=<staging-only password> \
//   node scripts/photo-staging-acceptance/staging-driver.mjs <command> [args]
//
// Commands:
//   w4 <categoryId> <img1> <img2>          create intake -> stage 2 photos -> mock proposal -> accept title -> stock
//                                           acceptance (creates the product) -> finalize-photos (201) -> repeat (200)
//   w2 <productId> <img> [key]              one protected W2 upload with an explicit Idempotency-Key
//   w2-replay <productId> <img>             same key twice: identical photo id (idempotent replay)
//   w2-lost-ack <productId> <img>           LOST ACKNOWLEDGEMENT: the request goes through a local proxy that waits for the
//                                           server's complete response (durable commit done), records it, and destroys the
//                                           client connection without delivering it; then the client retries the same key
//                                           directly and must receive the same photo id with no new photo
//
// Authentication: POST /api/auth/login sets the noctella_admin_session cookie. Requests send no Origin header, which
// the admin CSRF guard (requireAdminOriginForMutations) accepts for non-browser clients. Output: JSON lines only;
// credentials and cookies are never printed.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function guardTarget(env = process.env) {
  const api = env.F2_STAGING_API;
  if (!api) throw new Error("F2_STAGING_API is required");
  const url = new URL(api);
  if (url.host !== env.F2_STAGING_CONFIRM_HOST) throw new Error("refused: F2_STAGING_CONFIRM_HOST must equal the staging API host");
  return url;
}
const log = (event, data = {}) => console.log(JSON.stringify({ event, ...data }));

async function login(api, env) {
  const res = await fetch(new URL("/api/auth/login", api), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: env.F2_STAGING_EMAIL, password: env.F2_STAGING_PASSWORD }) });
  if (res.status !== 200) throw new Error(`login failed (${res.status})`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie.startsWith("noctella_admin_session=")) throw new Error("login returned no session cookie");
  return cookie;
}

async function call(api, cookie, method, route, body) {
  const headers = { cookie };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(new URL(route, api), { method, headers, body: payload });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}

function photoForm(file, field = "photo") {
  const form = new FormData();
  form.append(field, new Blob([fs.readFileSync(file)], { type: file.endsWith(".png") ? "image/png" : "image/jpeg" }), path.basename(file));
  return form;
}

async function w2Upload(api, cookie, productId, file, key, viaProxy) {
  const form = photoForm(file);
  form.append("altText", "");
  const target = viaProxy ? new URL(`/api/products/${productId}/photos`, viaProxy) : new URL(`/api/products/${productId}/photos`, api);
  const res = await fetch(target, { method: "POST", headers: { cookie, "idempotency-key": key }, body: form });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/**
 * Lost-acknowledgement proxy: forwards ONE request upstream, reads the COMPLETE upstream response (so the server has
 * finished: committed or failed), records it, and then destroys the client socket without sending anything back.
 */
export function startAckDroppingProxy(upstream) {
  const captured = [];
  const agent = upstream.protocol === "https:" ? https : http;
  const server = http.createServer((req, res) => {
    const out = agent.request({ protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || undefined, method: req.method, path: req.url,
      headers: { ...req.headers, host: upstream.host } }, (up) => {
      const chunks = [];
      up.on("data", (c) => chunks.push(c));
      up.on("end", () => {
        captured.push({ status: up.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        req.socket.destroy(); // the acknowledgement is lost AFTER the server completed the request
      });
    });
    out.on("error", (e) => { captured.push({ error: String(e.code ?? e) }); req.socket.destroy(); });
    req.pipe(out);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: new URL(`http://127.0.0.1:${server.address().port}`), captured, close: () => new Promise((r) => server.close(r)) })));
}

async function photoCount(api, cookie, productId) {
  const r = await call(api, cookie, "GET", `/api/products/${productId}`);
  if (r.status !== 200) throw new Error(`product read failed (${r.status})`);
  return { count: r.json.photos.length, ids: r.json.photos.map((p) => p.id) };
}

async function main(argv, env) {
  const api = guardTarget(env);
  const [command, ...args] = argv;
  const cookie = await login(api, env);
  if (command === "w2") {
    const [productId, file, key = `f2-staging-${randomUUID()}`] = args;
    log("w2", { key, ...(await w2Upload(api, cookie, productId, file, key)) });
  } else if (command === "w2-replay") {
    const [productId, file] = args, key = `f2-replay-${randomUUID()}`;
    const first = await w2Upload(api, cookie, productId, file, key), second = await w2Upload(api, cookie, productId, file, key);
    log("w2-replay", { key, first: first.status, second: second.status, samePhoto: first.json.id === second.json.id && !!first.json.id });
  } else if (command === "w2-lost-ack") {
    const [productId, file] = args, key = `f2-lostack-${randomUUID()}`;
    const before = await photoCount(api, cookie, productId);
    const proxy = await startAckDroppingProxy(api);
    let clientOutcome;
    try { await w2Upload(api, cookie, productId, file, key, proxy.url); clientOutcome = "UNEXPECTED_ACK_DELIVERED"; }
    catch (e) { clientOutcome = `ack-lost (${e.cause?.code ?? e.name})`; }
    finally { await proxy.close(); }
    const upstream = proxy.captured[0] ?? {};
    const committedId = (() => { try { return JSON.parse(upstream.body).id; } catch { return null; } })();
    const afterLoss = await photoCount(api, cookie, productId);
    const retry = await w2Upload(api, cookie, productId, file, key);
    const afterRetry = await photoCount(api, cookie, productId);
    log("w2-lost-ack", {
      key, clientOutcome, upstreamStatus: upstream.status ?? upstream.error, retryStatus: retry.status,
      sameIdAsCommitted: !!committedId && retry.json.id === committedId,
      photosBefore: before.count, photosAfterLoss: afterLoss.count, photosAfterRetry: afterRetry.count,
      pass: clientOutcome.startsWith("ack-lost") && upstream.status === 201 && retry.status === 201 && retry.json.id === committedId
        && afterLoss.count === before.count + 1 && afterRetry.count === afterLoss.count,
    });
  } else if (command === "w4") {
    const [categoryId, img1, img2] = args;
    const intake = await call(api, cookie, "POST", "/api/ai-product-intakes", {});
    if (intake.status !== 201 && intake.status !== 200) throw new Error(`intake create ${intake.status}`);
    const id = intake.json.id;
    for (const img of [img1, img2]) { const r = await call(api, cookie, "POST", `/api/ai-product-intakes/${id}/photos`, photoForm(img)); if (r.status >= 300) throw new Error(`intake photo ${r.status}`); }
    const gen = await call(api, cookie, "POST", `/api/ai-product-intakes/${id}/generate`, {});
    if (gen.status >= 300) throw new Error(`generate ${gen.status} (AI_INTAKE_PROVIDER must be unset or mock on staging)`);
    let proposal = await call(api, cookie, "GET", `/api/ai-product-intakes/${id}/proposal`);
    const accepted = await call(api, cookie, "PATCH", `/api/ai-product-intakes/${id}/proposal/fields/title`, { decision: "accepted", expectedUpdatedAt: proposal.json.updatedAt });
    if (accepted.status >= 300) throw new Error(`accept title ${accepted.status}`);
    proposal = await call(api, cookie, "GET", `/api/ai-product-intakes/${id}/proposal`);
    const stock = await call(api, cookie, "POST", `/api/ai-product-intakes/${id}/stock-acceptance`, { categoryId, type: "unique_item", expectedProposalUpdatedAt: proposal.json.updatedAt });
    if (stock.status !== 201) throw new Error(`stock acceptance ${stock.status}`);
    const first = await call(api, cookie, "POST", `/api/ai-product-intakes/${id}/finalize-photos`, {});
    const second = await call(api, cookie, "POST", `/api/ai-product-intakes/${id}/finalize-photos`, {});
    log("w4", { intakeId: id, productId: stock.json.id, finalize: first.status, photos: first.json.photos?.length, repeat: second.status, repeatPhotos: second.json.photos?.length,
      pass: first.status === 201 && first.json.photos?.length === 2 && second.status === 200 && second.json.photos?.length === 2 });
  } else {
    throw new Error("unknown command (w4 | w2 | w2-replay | w2-lost-ack)");
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("staging-driver.mjs")) {
  main(process.argv.slice(2), process.env).catch((e) => { log("error", { message: String(e.message ?? e) }); process.exitCode = 1; });
}
