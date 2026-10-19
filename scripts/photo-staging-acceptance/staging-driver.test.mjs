// Deterministic checks of the staging tooling's own mechanisms (no staging, no network beyond loopback).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { guardTarget, startAckDroppingProxy } from "./staging-driver.mjs";
import { refuseUnlessStaging, PRODUCTION_SERVICE_ID } from "./park-at-intent.mjs";

test("the lost-ack proxy delivers nothing to the client only after the server completed (committed) the request", async () => {
  let commits = 0;
  const server = http.createServer((req, res) => { req.resume(); req.on("end", () => { commits += 1; res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "photo-1" })); }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const upstream = new URL(`http://127.0.0.1:${server.address().port}`);
  const proxy = await startAckDroppingProxy(upstream);
  try {
    await assert.rejects(fetch(new URL("/api/products/p/photos", proxy.url), { method: "POST", body: "x" }));
    assert.equal(commits, 1);
    assert.deepEqual(proxy.captured, [{ status: 201, body: JSON.stringify({ id: "photo-1" }) }]);
  } finally { await proxy.close(); await new Promise((r) => server.close(r)); }
});

test("the driver refuses any host that was not explicitly confirmed", () => {
  assert.throws(() => guardTarget({ F2_STAGING_API: "https://api.example.test" }), /CONFIRM_HOST/);
  assert.throws(() => guardTarget({ F2_STAGING_API: "https://api.example.test", F2_STAGING_CONFIRM_HOST: "other.test" }), /CONFIRM_HOST/);
  assert.equal(guardTarget({ F2_STAGING_API: "https://api.example.test", F2_STAGING_CONFIRM_HOST: "api.example.test" }).host, "api.example.test");
});

test("park-at-intent refuses production, a missing explicit flag, and fencing OFF", () => {
  assert.throws(() => refuseUnlessStaging({ RENDER_SERVICE_ID: PRODUCTION_SERVICE_ID, F2_STAGING_ACCEPTANCE: "enabled", PHOTO_OWNERSHIP_FENCING_ENABLED: "true" }), /production/);
  assert.throws(() => refuseUnlessStaging({ PHOTO_OWNERSHIP_FENCING_ENABLED: "true" }), /F2_STAGING_ACCEPTANCE/);
  assert.throws(() => refuseUnlessStaging({ F2_STAGING_ACCEPTANCE: "enabled" }), /fencing/);
  assert.doesNotThrow(() => refuseUnlessStaging({ F2_STAGING_ACCEPTANCE: "enabled", PHOTO_OWNERSHIP_FENCING_ENABLED: "true", RENDER_SERVICE_ID: "srv-staging" }));
});
