import type { Response } from "express";
import { ZodError } from "zod";
import { formatZodError } from "../validation/common";
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from "../services/errors";
import { InventoryUseCaseError, type InventoryErrorCategory } from "../application/inventory/errors";

// Sprint 64D: InventoryUseCaseError previously fell through to the generic 500 branch below -
// it doesn't extend BadRequestError/ConflictError/NotFoundError, so none of the checks above
// recognized it. Mapped here by category (set per-subclass in application/inventory/errors.ts)
// rather than by instanceof-per-subclass, so new inventory error subtypes are covered
// automatically as long as they declare a category.
const INVENTORY_ERROR_STATUS: Record<InventoryErrorCategory, number> = {
  validation: 400,
  not_found: 404,
  conflict: 409,
};

export function handleRouteError(err: unknown, res: Response): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation failed", details: formatZodError(err) });
    return;
  }
  if (err instanceof UnauthorizedError) {
    res.status(401).json({ error: err.message });
    return;
  }
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof ConflictError) {
    res.status(409).json({ error: err.message });
    return;
  }
  if (err instanceof BadRequestError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof InventoryUseCaseError) {
    res.status(INVENTORY_ERROR_STATUS[err.category]).json({ error: err.message });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}
