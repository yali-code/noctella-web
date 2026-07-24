import { Router } from "express";
import { PublishChannel } from "@noctella/shared";
import { requirePermission } from "../auth/permissions";
import { db } from "../db/client";
import { completeConnect, disconnect, getConnection, listConnections, refreshConnection, startConnect, verifyConnection } from "../services/marketplacePublishing";
import { handleRouteError } from "./errorHandler";
const router = Router();
function channel(value: string) { return value as PublishChannel; }
router.get("/connections", requirePermission("marketplace.view"), async (_req, res) => { try { res.json(await listConnections(db)); } catch (err) { handleRouteError(err, res); } });
router.get("/connections/:channel", requirePermission("marketplace.view"), async (req, res) => { try { res.json(await getConnection(db, channel(req.params.channel)) ?? null); } catch (err) { handleRouteError(err, res); } });
router.post("/:channel/connect", requirePermission("marketplace.manage"), async (req, res) => { try { if (req.params.channel === PublishChannel.NoctellaWeb) { res.status(400).json({ error: "NoctellaWeb does not use OAuth" }); return; } res.json(await startConnect(channel(req.params.channel), req.body?.accountLabel)); } catch (err) { handleRouteError(err, res); } });
router.get("/:channel/callback", requirePermission("marketplace.manage"), async (req, res) => { try { res.json(await completeConnect(db, channel(req.params.channel), String(req.query.code ?? ""), String(req.query.state ?? ""), String(req.query.expectedState ?? ""), String(req.query.accountLabel ?? "Default"))); } catch (err) { handleRouteError(err, res); } });
router.post("/:channel/refresh", requirePermission("marketplace.manage"), async (req, res) => { try { res.json(await refreshConnection(db, channel(req.params.channel))); } catch (err) { handleRouteError(err, res); } });
router.delete("/:channel/disconnect", requirePermission("marketplace.manage"), async (req, res) => { try { res.json(await disconnect(db, channel(req.params.channel)) ?? null); } catch (err) { handleRouteError(err, res); } });
router.post("/:channel/verify", requirePermission("marketplace.manage"), async (req, res) => { try { res.json(await verifyConnection(db, channel(req.params.channel))); } catch (err) { handleRouteError(err, res); } });
export default router;
