import type { DbClient } from "../db/client";
import { listShippingMethods } from "./shippingMethods";
import { mockPaymentsEnabled, stripePublicCheckoutEnabled } from "../payments/paymentService";
import { parseConfiguredOrigins } from "../auth/originAllowlist";
import { evaluateReadiness, type ReadinessResult } from "../use-cases/readiness/useCases";

/**
 * Sprint 135: Service layer for GET /ready - resolves every input the pure use case needs, then
 * delegates the actual pass/fail decision to evaluateReadiness. Shipping state is read through
 * the existing canonical shipping Service (listShippingMethods, itself backed by the shipping
 * repository) - no direct database/repository access from here or from the route, preserving
 * Route -> Service -> UseCase -> Repository.
 *
 * Sprint 135 correction: origin-configured checks now reuse the exact same
 * split-comma/trim-each/filter-empty normalization app.ts's real CORS allowlist uses
 * (auth/originAllowlist.ts), instead of a weaker whole-string trim - a comma-only value like
 * "," ,"" is non-empty after a single trim but resolves to zero usable origins once split, which
 * previously made readiness report "configured" for an origin CORS would actually treat as absent.
 */
export async function getReadiness(db: DbClient, env: NodeJS.ProcessEnv = process.env): Promise<ReadinessResult> {
  const methods = await listShippingMethods(db);
  const hasActiveShippingMethod = methods.some((m) => m.isActive);
  return evaluateReadiness({
    hasActiveShippingMethod,
    stripePublicCheckoutEnabled: stripePublicCheckoutEnabled(env),
    mockPaymentsEnabled: mockPaymentsEnabled(env),
    adminAppOriginConfigured: parseConfiguredOrigins(env.ADMIN_APP_ORIGIN).length > 0,
    storefrontAppOriginConfigured: parseConfiguredOrigins(env.STOREFRONT_APP_ORIGIN).length > 0,
  });
}
