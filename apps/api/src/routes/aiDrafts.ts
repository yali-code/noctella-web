import { Router } from "express";
import { requirePermission, type AuthedRequest } from "../auth/permissions";
import { db } from "../db/client";
import {
  approveDraft,
  generateDraft,
  getDraftById,
  listDrafts,
  regenerateDraft,
  rejectDraft,
  updateDraft,
} from "../services/aiDrafts";
import {
  aiDraftListQuerySchema,
  approveDraftSchema,
  regenerateDraftSchema,
  rejectDraftSchema,
  updateDraftSchema,
} from "../validation/aiDraft";
import { handleRouteError } from "./errorHandler";

const router = Router();

router.get("/", requirePermission("ai_drafts.view"), async (req, res) => {
  try {
    const query = aiDraftListQuerySchema.parse(req.query);
    const result = await listDrafts(db, query);
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/:id", requirePermission("ai_drafts.view"), async (req, res) => {
  try {
    const draft = await getDraftById(db, req.params.id);
    res.json(draft);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.patch("/:id", requirePermission("ai_drafts.review"), async (req, res) => {
  try {
    const input = updateDraftSchema.parse(req.body);
    const draft = await updateDraft(db, req.params.id, input);
    res.json(draft);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/approve", requirePermission("ai_drafts.review"), async (req: AuthedRequest, res) => {
  try {
    approveDraftSchema.parse(req.body ?? {});
    // Sprint 89: reviewer identity comes only from the authenticated session -
    // requirePermission already guarantees req.adminUser is set (see its own
    // fail-closed 401 check), never from a client-supplied body field.
    const draft = await approveDraft(db, req.params.id, req.adminUser!.id);
    res.json(draft);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/reject", requirePermission("ai_drafts.review"), async (req, res) => {
  try {
    const input = rejectDraftSchema.parse(req.body ?? {});
    const draft = await rejectDraft(db, req.params.id, input);
    res.json(draft);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/regenerate", requirePermission("ai_drafts.review"), async (req, res) => {
  try {
    regenerateDraftSchema.parse(req.body ?? {});
    const draft = await regenerateDraft(db, req.params.id);
    res.json(draft);
  } catch (err) {
    handleRouteError(err, res);
  }
});

export default router;
