import { randomUUID } from "node:crypto";
import { ShippingRuleType } from "@noctella/shared";
import type { DbClient } from "../db/client";
import { createShippingMethodRepository } from "../repositories/shipping/drizzle";
import type { ShippingMethodRecord } from "../repositories/shipping/types";
import { BadRequestError, NotFoundError } from "./errors";
import type { CreateShippingMethodInput, UpdateShippingMethodInput } from "../validation/shipping";

function driverFor(): "sqlite" | "postgres" {
  return process.env.DATABASE_DRIVER === "postgres" || process.env.DATABASE_DRIVER === "supabase-postgres" ? "postgres" : "sqlite";
}
function repo(db: DbClient) {
  return createShippingMethodRepository(db, driverFor());
}

/**
 * Sprint 134: cross-field rule-type validation, mirroring services/companyProfile.ts's own
 * merge-then-validate convention (assertRequiredFields) - Zod alone can't express "required only
 * for this ruleType" cleanly across create/update without duplicating the whole shape twice.
 */
function assertValidRuleConfig(merged: { ruleType: string; flatAmountEurCents: number | null; freeThresholdEurCents: number | null }): void {
  if (merged.ruleType === ShippingRuleType.FlatRate && (merged.flatAmountEurCents == null || merged.flatAmountEurCents < 0)) {
    throw new BadRequestError("flatAmountEurCents is required and must be non-negative for FlatRate");
  }
  if (merged.ruleType === ShippingRuleType.FreeOverSubtotal) {
    if (merged.flatAmountEurCents == null || merged.flatAmountEurCents < 0) throw new BadRequestError("flatAmountEurCents is required and must be non-negative for FreeOverSubtotal");
    if (merged.freeThresholdEurCents == null || merged.freeThresholdEurCents < 0) throw new BadRequestError("freeThresholdEurCents is required and must be non-negative for FreeOverSubtotal");
  }
}

export async function listShippingMethods(db: DbClient): Promise<ShippingMethodRecord[]> {
  return repo(db).list();
}

export async function getShippingMethodById(db: DbClient, id: string): Promise<ShippingMethodRecord> {
  const row = await repo(db).getById(id);
  if (!row) throw new NotFoundError("Shipping method not found");
  return row;
}

export async function createShippingMethod(db: DbClient, input: CreateShippingMethodInput): Promise<ShippingMethodRecord> {
  const merged = {
    ruleType: input.ruleType,
    flatAmountEurCents: input.flatAmountEurCents ?? null,
    freeThresholdEurCents: input.freeThresholdEurCents ?? null,
  };
  assertValidRuleConfig(merged);
  const now = new Date().toISOString();
  return repo(db).create({
    id: randomUUID(),
    label: input.label,
    isActive: input.isActive ?? true,
    sortOrder: input.sortOrder ?? 0,
    ruleType: input.ruleType,
    flatAmountEurCents: merged.flatAmountEurCents,
    freeThresholdEurCents: merged.freeThresholdEurCents,
    countryCodes: input.countryCodes && input.countryCodes.length > 0 ? input.countryCodes : null,
    shippingProfiles: input.shippingProfiles && input.shippingProfiles.length > 0 ? input.shippingProfiles : null,
    createdAt: now,
    updatedAt: now,
  });
}

export async function updateShippingMethod(db: DbClient, id: string, input: UpdateShippingMethodInput): Promise<ShippingMethodRecord> {
  const existing = await getShippingMethodById(db, id);
  const merged = {
    ruleType: input.ruleType ?? existing.ruleType,
    flatAmountEurCents: input.flatAmountEurCents !== undefined ? input.flatAmountEurCents : existing.flatAmountEurCents,
    freeThresholdEurCents: input.freeThresholdEurCents !== undefined ? input.freeThresholdEurCents : existing.freeThresholdEurCents,
  };
  assertValidRuleConfig(merged);
  const patch: any = { updatedAt: new Date().toISOString() };
  for (const field of ["label", "isActive", "sortOrder", "ruleType", "flatAmountEurCents", "freeThresholdEurCents", "countryCodes", "shippingProfiles"] as const) {
    if (input[field] !== undefined) patch[field] = input[field];
  }
  if (patch.countryCodes && patch.countryCodes.length === 0) patch.countryCodes = null;
  if (patch.shippingProfiles && patch.shippingProfiles.length === 0) patch.shippingProfiles = null;
  const updated = await repo(db).update(id, patch);
  if (!updated) throw new NotFoundError("Shipping method not found");
  return updated;
}
