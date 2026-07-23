import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import express from "express";

/**
 * Sprint 56B: no HTTP/route-level tests existed for apps/api/src/routes/returns.ts before
 * this sprint (only use-case/service-level tests) - required because the admin UI now calls
 * these routes directly. `../src/db/client`'s module-scope `db` singleton (a real sqlite file
 * at ./data/dev.sqlite by default) is mocked here so the router runs against an isolated
 * in-memory database instead of writing into the shared dev database.
 */
let harnessRef: any;
vi.mock("../src/db/client", async () => {
  const { createReturnRefundSqliteHarness } = await import("./helpers/returnRefundHarness");
  harnessRef = createReturnRefundSqliteHarness();
  return { db: harnessRef.db, dbRuntime: { driver: "sqlite", db: harnessRef.db, shutdown: async () => harnessRef.cleanup() } };
});

describe("returns/refunds routes (Sprint 56B)", () => {
  let server: Server;
  let baseUrl: string;
  let seedOrderGraph: typeof import("./helpers/returnRefundHarness").seedOrderGraph;

  beforeAll(async () => {
    ({ seedOrderGraph } = await import("./helpers/returnRefundHarness"));
    const returnsRouter = (await import("../src/routes/returns")).default;
    const app = express();
    app.use(express.json());
    app.use("/api", returnsRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    harnessRef.cleanup();
  });

  async function createReturn(orderId: string, orderItemId: string, idempotencyKey?: string) {
    const res = await fetch(`${baseUrl}/api/orders/${orderId}/returns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "damaged", items: [{ orderItemId, quantityRequested: 1 }], idempotencyKey }),
    });
    return { status: res.status, body: await res.json() };
  }

  it("A: a representative return transition (authorize) succeeds over real HTTP and persists the new status", async () => {
    const graph = await seedOrderGraph(harnessRef.db, "route-a");
    const created = await createReturn(graph.order.id, graph.orderItem.id);
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("requested");

    const res = await fetch(`${baseUrl}/api/returns/${created.body.id}/authorize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("authorized");

    const getRes = await fetch(`${baseUrl}/api/returns/${created.body.id}`);
    expect((await getRes.json()).status).toBe("authorized");
  });

  it("B: create-return idempotency - the same idempotencyKey+payload posted twice returns the same return, not a duplicate", async () => {
    const graph = await seedOrderGraph(harnessRef.db, "route-b");
    const first = await createReturn(graph.order.id, graph.orderItem.id, "idem-route-b");
    const second = await createReturn(graph.order.id, graph.orderItem.id, "idem-route-b");
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);

    const list = await fetch(`${baseUrl}/api/orders/${graph.order.id}/returns`);
    expect((await list.json())).toHaveLength(1);
  });

  it("C: refund submit succeeds over real HTTP and transitions the refund to pending", async () => {
    const graph = await seedOrderGraph(harnessRef.db, "route-c");
    const createRes = await fetch(`${baseUrl}/api/orders/${graph.order.id}/refunds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subtotalAmount: 10, idempotencyKey: "refund-route-c" }),
    });
    expect(createRes.status).toBe(201);
    const refund = await createRes.json();
    expect(refund.status).toBe("draft");

    const submitRes = await fetch(`${baseUrl}/api/refunds/${refund.id}/submit`, { method: "POST" });
    expect(submitRes.status).toBe(200);
    expect((await submitRes.json()).status).toBe("pending");
  });

  it("D: refund cancel succeeds over real HTTP and transitions the refund to cancelled", async () => {
    const graph = await seedOrderGraph(harnessRef.db, "route-d");
    const createRes = await fetch(`${baseUrl}/api/orders/${graph.order.id}/refunds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subtotalAmount: 10, idempotencyKey: "refund-route-d" }),
    });
    const refund = await createRes.json();
    const cancelRes = await fetch(`${baseUrl}/api/refunds/${refund.id}/cancel`, { method: "POST" });
    expect(cancelRes.status).toBe(200);
    expect((await cancelRes.json()).status).toBe("cancelled");
  });

  it("E: HTTP error mapping - not-found maps to 404 and an invalid transition maps to 400 with the real backend message", async () => {
    const notFound = await fetch(`${baseUrl}/api/returns/does-not-exist`);
    expect(notFound.status).toBe(404);
    expect((await notFound.json()).error).toMatch(/not found/i);

    const graph = await seedOrderGraph(harnessRef.db, "route-e");
    const created = await createReturn(graph.order.id, graph.orderItem.id);
    // Already "requested" - receive is only valid from authorized/in_transit, so this must 400.
    const invalid = await fetch(`${baseUrl}/api/returns/${created.body.id}/receive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toMatch(/invalid return status transition/i);
  });
});
