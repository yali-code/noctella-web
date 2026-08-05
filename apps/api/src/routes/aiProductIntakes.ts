import { Router } from "express";
import multer from "multer";
import { requirePermission, type AuthedRequest } from "../auth/permissions";
import { db } from "../db/client";
import { cancelIntake, createIntake, getIntakeById, listIntakes } from "../services/aiProductIntakes";
import { deleteIntakePhoto, listIntakePhotos, uploadIntakePhoto } from "../services/aiIntakePhotos";
import { generateIntakeProposal } from "../services/aiIntakeGeneration";
import { getCurrentProposal, updateProposalFieldReview } from "../services/aiIntakeProposals";
import { saveAiIntakeAsDraft } from "../services/aiIntakeApply";
import { finalizeAiIntakePhotos } from "../services/aiIntakePhotoFinalization";
import { runAiIntakeCleanupForAdmin } from "../services/aiIntakeCleanup";
import {
  aiProductIntakeListQuerySchema,
  cancelAiProductIntakeSchema,
  createAiProductIntakeSchema,
  generateAiIntakeProposalSchema,
} from "../validation/aiProductIntake";
import { descriptionFieldReviewSchema, keywordsFieldReviewSchema, titleFieldReviewSchema } from "../validation/aiIntakeProposal";
import { saveAiIntakeAsDraftSchema } from "../validation/aiIntakeApply";
import { finalizeAiIntakePhotosSchema } from "../validation/aiIntakePhotoFinalize";
import { aiIntakeCleanupRunSchema } from "../validation/aiIntakeCleanup";
import { BadRequestError } from "../services/errors";
import { handleRouteError } from "./errorHandler";
import type { AiIntakeProposalField } from "../repositories/ai-intake-proposal/types";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * Sprint 96: Admin dry-run/execute entry point for AI intake staged-photo
 * retention cleanup and orphan-file recovery. Registered before the
 * `/:id`-shaped routes below for readability; there is no actual routing
 * collision either way ("/cleanup/run" is a two-segment path no other route
 * in this router shares, and none of the `/:id/<literal>` routes below use
 * "cleanup" or "run" as their literal segment). The route never inspects
 * files, reads retention env vars, queries cleanup tables, classifies
 * candidates, or deletes anything itself - it only parses/validates the
 * request and delegates entirely to services/aiIntakeCleanup.ts.
 */
router.post("/cleanup/run", requirePermission("ai_product_intakes.manage"), async (req: AuthedRequest, res) => {
  try {
    const input = aiIntakeCleanupRunSchema.parse(req.body ?? {});
    const result = await runAiIntakeCleanupForAdmin(db, { dryRun: input.dryRun, batchSize: input.batchSize });
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/", requirePermission("ai_product_intakes.manage"), async (req: AuthedRequest, res) => {
  try {
    createAiProductIntakeSchema.parse(req.body ?? {});
    // Creator identity comes only from the authenticated session -
    // requirePermission already guarantees req.adminUser is set, never from
    // a client-supplied body field.
    const intake = await createIntake(db, req.adminUser!.id);
    res.status(201).json(intake);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/", requirePermission("ai_product_intakes.view"), async (req, res) => {
  try {
    const query = aiProductIntakeListQuerySchema.parse(req.query);
    const result = await listIntakes(db, query);
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/:id", requirePermission("ai_product_intakes.view"), async (req, res) => {
  try {
    const intake = await getIntakeById(db, req.params.id);
    res.json(intake);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.post("/:id/cancel", requirePermission("ai_product_intakes.manage"), async (req: AuthedRequest, res) => {
  try {
    const input = cancelAiProductIntakeSchema.parse(req.body ?? {});
    // Canceller identity comes only from the authenticated session, never a
    // client-supplied body field.
    const intake = await cancelIntake(db, req.params.id, req.adminUser!.id, input.cancellationReason);
    res.json(intake);
  } catch (err) {
    handleRouteError(err, res);
  }
});

// Sprint 91: AI Intake Photo foundation - nested under the owning intake.
// Actor identity always comes from req.adminUser.id, never the request body.
router.post("/:id/photos", requirePermission("ai_product_intakes.manage"), upload.single("photo"), async (req: AuthedRequest, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "Photo file is required" });
      return;
    }
    const photo = await uploadIntakePhoto(db, req.params.id, req.file, req.file.originalname, req.adminUser!.id);
    res.status(201).json(photo);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/:id/photos", requirePermission("ai_product_intakes.view"), async (req, res) => {
  try {
    const photos = await listIntakePhotos(db, req.params.id);
    res.json(photos);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.delete("/:id/photos/:photoId", requirePermission("ai_product_intakes.manage"), async (req, res) => {
  try {
    await deleteIntakePhoto(db, req.params.id, req.params.photoId);
    res.status(204).end();
  } catch (err) {
    handleRouteError(err, res);
  }
});

// Sprint 92/93: AI Intake generation provider seam - Sprint 93 made this
// server-authoritative and durable (persists exactly one current proposal
// per intake). The strict empty body rejects any client-supplied field,
// consistent with every other endpoint on this router.
router.post("/:id/generate", requirePermission("ai_product_intakes.manage"), async (req, res) => {
  try {
    generateAiIntakeProposalSchema.parse(req.body ?? {});
    const result = await generateIntakeProposal(db, req.params.id);
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

router.get("/:id/proposal", requirePermission("ai_product_intakes.view"), async (req, res) => {
  try {
    const result = await getCurrentProposal(db, req.params.id);
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

const FIELD_SCHEMAS = {
  title: titleFieldReviewSchema,
  description: descriptionFieldReviewSchema,
  keywords: keywordsFieldReviewSchema,
} as const;

// Sprint 93: actor (reviewer) identity always comes from req.adminUser.id,
// never the request body.
router.patch("/:id/proposal/fields/:field", requirePermission("ai_product_intakes.manage"), async (req: AuthedRequest, res) => {
  try {
    const field = req.params.field as AiIntakeProposalField;
    const schema = FIELD_SCHEMAS[field];
    if (!schema) throw new BadRequestError(`Unknown proposal field: "${req.params.field}"`);

    const input = schema.parse(req.body ?? {});
    const result = await updateProposalFieldReview(db, req.params.id, field, input.decision, input.value, req.adminUser!.id, input.expectedUpdatedAt);
    res.json(result);
  } catch (err) {
    handleRouteError(err, res);
  }
});

// Sprint 94: explicit human-triggered canonical apply transaction. Requires
// both intake-management and Product-creation privilege, since this single
// action performs both. Applying actor identity always comes from
// req.adminUser.id, never the request body - title/description/keywords are
// never accepted here either, since they are read server-side from the
// durable proposal. An already-Applied intake is an idempotent success
// (200, the existing Product), never a second Product.
router.post(
  "/:id/save-as-draft",
  requirePermission("ai_product_intakes.manage"),
  requirePermission("products.edit"),
  async (req: AuthedRequest, res) => {
    try {
      const input = saveAiIntakeAsDraftSchema.parse(req.body ?? {});
      const result = await saveAiIntakeAsDraft(db, req.params.id, input, req.adminUser!.id);
      res.status(result.created ? 201 : 200).json(result.product);
    } catch (err) {
      handleRouteError(err, res);
    }
  },
);

// Sprint 95: explicit human-triggered canonical photo finalization. Requires
// both intake-management and Product-creation privilege, mirroring
// /save-as-draft, since this single action both finalizes the intake and
// creates canonical ProductPhoto rows. Actor identity always comes from
// req.adminUser.id, never the request body - only an optional Primary
// selection is ever accepted. An already-Finalized intake is an idempotent
// success (200, the existing canonical Product), never a second write.
router.post(
  "/:id/finalize-photos",
  requirePermission("ai_product_intakes.manage"),
  requirePermission("products.edit"),
  async (req: AuthedRequest, res) => {
    try {
      const input = finalizeAiIntakePhotosSchema.parse(req.body ?? {});
      const result = await finalizeAiIntakePhotos(db, req.params.id, input, req.adminUser!.id);
      res.status(result.created ? 201 : 200).json(result.product);
    } catch (err) {
      handleRouteError(err, res);
    }
  },
);

export default router;
