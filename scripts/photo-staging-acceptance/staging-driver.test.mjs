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

test("the driver refuses a missing/production/mismatched target identity before any request", () => {
  const ok = { F2_STAGING_API: "https://f2-staging.example.test", F2_STAGING_CONFIRM_HOST: "f2-staging.example.test", F2_STAGING_TARGET_SERVICE_ID: "srv-abcdef123456", F2_PRODUCTION_HOSTS: "api.example.test" };
  assert.equal(guardTarget(ok).host, "f2-staging.example.test");
  assert.throws(() => guardTarget({ ...ok, F2_STAGING_TARGET_SERVICE_ID: undefined }), /TARGET_SERVICE_ID/);
  assert.throws(() => guardTarget({ ...ok, F2_STAGING_TARGET_SERVICE_ID: "srv-db34390m7kps73cv8l6g" }), /production service/);
  assert.throws(() => guardTarget({ ...ok, F2_PRODUCTION_HOSTS: "" }), /PRODUCTION_HOSTS/);
  assert.throws(() => guardTarget({ ...ok, F2_STAGING_API: "https://api.example.test", F2_STAGING_CONFIRM_HOST: "api.example.test" }), /production host/);
  assert.throws(() => guardTarget({ ...ok, F2_STAGING_CONFIRM_HOST: "other.test" }), /CONFIRM_HOST/);
});

test("park-at-intent fails closed on absent/production/mismatched identity, fencing OFF, missing confinement or roots", () => {
  const ok = { F2_STAGING_ACCEPTANCE: "enabled", RENDER_SERVICE_ID: "srv-staging123", F2_STAGING_TARGET_SERVICE_ID: "srv-staging123", PHOTO_OWNERSHIP_FENCING_ENABLED: "true",
    PHOTO_PREPARATION_CONFINEMENT: "required", PHOTO_PREPARATION_LAUNCHER: "/x/landlock-worker", DATABASE_URL: "/var/data/noctella.sqlite", PRODUCT_PHOTO_DIR: "/var/data/product-photos" };
  assert.doesNotThrow(() => refuseUnlessStaging(ok));
  assert.throws(() => refuseUnlessStaging({ ...ok, F2_STAGING_ACCEPTANCE: undefined }), /F2_STAGING_ACCEPTANCE/);
  assert.throws(() => refuseUnlessStaging({ ...ok, RENDER_SERVICE_ID: undefined }), /absent/);
  assert.throws(() => refuseUnlessStaging({ ...ok, RENDER_SERVICE_ID: PRODUCTION_SERVICE_ID, F2_STAGING_TARGET_SERVICE_ID: PRODUCTION_SERVICE_ID }), /production/);
  assert.throws(() => refuseUnlessStaging({ ...ok, F2_STAGING_TARGET_SERVICE_ID: "srv-other" }), /does not match/);
  assert.throws(() => refuseUnlessStaging({ ...ok, PHOTO_OWNERSHIP_FENCING_ENABLED: "false" }), /fencing/);
  assert.throws(() => refuseUnlessStaging({ ...ok, PHOTO_PREPARATION_CONFINEMENT: undefined }), /confined/);
  assert.throws(() => refuseUnlessStaging({ ...ok, DATABASE_URL: undefined }), /DATABASE_URL/);
});
