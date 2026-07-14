import express from "express";
import { PublishChannel } from "@noctella/shared";
import { db } from "../db/client";
import { getExternalListing, getMarketplaceOrder, getSyncRun, importMarketplaceOrder, listExternalListingsForAdmin, listMarketplaceOrders, listSyncRuns, listWebhookEvents, processWebhook, retryMarketplaceOrder, syncExternalListing } from "../services/marketplaceSync";

const router = express.Router();
function channel(v: string) { return v === "ebay" ? PublishChannel.Ebay : v === "etsy" ? PublishChannel.Etsy : undefined; }
router.use(express.raw({ type: "*/*" }));
router.post("/webhooks/:channel", async (req, res, next) => { try { const ch=channel(req.params.channel); if(!ch) return res.status(404).json({error:"Unsupported channel"}); res.json(await processWebhook(db, ch, Buffer.isBuffer(req.body)?req.body:Buffer.from(JSON.stringify(req.body)), req.headers)); } catch(e) { next(e); } });
export default router;
