import { ProductShippingProfile, ShippingRuleType } from "@noctella/shared";
import { BadRequestError, ConflictError, NotFoundError } from "../../services/errors";
import type { ShippingMethodRecord } from "../../repositories/shipping/types";
import type { UnitOfWork } from "../../services/unitOfWork";
import type { ShippingQuoteRequest } from "../../validation/shipping";

/** Same exact-integer-cents formula as use-cases/order/useCases.ts's toEurCents - duplicated locally (not imported) to avoid a circular dependency, since order/useCases.ts itself imports from this file. */
const toEurCents = (amount: number) => Math.round((amount + Number.EPSILON) * 100);

export interface ShippingResolutionInput {
  subtotalEurCents: number;
  /** Already normalized (uppercase, 2-letter) by the validation layer, or undefined if the request omitted it. */
  countryCode?: string;
  /** One effective profile per distinct product in the cart (product.shippingProfile ?? Standard) - never SUM/MAX/etc, see isEligible. */
  effectiveProfiles: string[];
}

export interface ResolvedShippingOption {
  shippingMethodId: string;
  label: string;
  ruleType: string;
  amountEurCents: number;
}

/**
 * A method is eligible only if it is active, its country restriction (if any) includes the
 * destination, and its product-profile restriction (if any) covers EVERY effective profile in the
 * cart - never a hidden SUM/MAX/MOST_EXPENSIVE/CHEAPEST combination rule. A method with no
 * restriction on a given axis is eligible for every value on that axis.
 */
function isEligible(method: ShippingMethodRecord, countryCode: string | undefined, effectiveProfiles: string[]): boolean {
  if (!method.isActive) return false;
  if (method.countryCodes && method.countryCodes.length > 0) {
    if (!countryCode || !method.countryCodes.includes(countryCode)) return false;
  }
  if (method.shippingProfiles && method.shippingProfiles.length > 0) {
    if (effectiveProfiles.some((profile) => !method.shippingProfiles!.includes(profile))) return false;
  }
  return true;
}

/** Exact EUR-cents rule evaluation - never floating decimals, never epsilon comparison. An unrecognized rule type fails closed rather than silently resolving to any amount. */
function amountForMethod(method: ShippingMethodRecord, subtotalEurCents: number): number {
  if (method.ruleType === ShippingRuleType.Free) return 0;
  if (method.ruleType === ShippingRuleType.FlatRate) return method.flatAmountEurCents ?? 0;
  if (method.ruleType === ShippingRuleType.FreeOverSubtotal) {
    return subtotalEurCents >= (method.freeThresholdEurCents ?? 0) ? 0 : (method.flatAmountEurCents ?? 0);
  }
  throw new BadRequestError("Shipping method has an unsupported rule type");
}

/** Pure: every eligible option for this cart/destination, in the repository's deterministic sortOrder. Shared by the public quote endpoint and final checkout resolution, so both always agree. */
export function listEligibleShippingOptions(activeMethods: ShippingMethodRecord[], input: ShippingResolutionInput): ResolvedShippingOption[] {
  return activeMethods
    .filter((method) => isEligible(method, input.countryCode, input.effectiveProfiles))
    .map((method) => ({ shippingMethodId: method.id, label: method.label, ruleType: method.ruleType, amountEurCents: amountForMethod(method, input.subtotalEurCents) }));
}

export interface FinalShippingResolutionInput extends ShippingResolutionInput {
  requestedShippingMethodId?: string;
  expectedShippingAmountEurCents?: number;
}

export interface FinalShippingResolution {
  shippingMethodId: string | null;
  shippingMethodLabel: string | null;
  shippingAmountEurCents: number;
}

/**
 * Authoritative final resolution for checkout. `allMethods` (unfiltered by active state) is
 * required only to distinguish two states that must NOT be conflated:
 *   - shipping has never been configured at all (zero rows exist, active or not) - legacy/bootstrap
 *     state, shippingAmount stays 0 and no snapshot is written, preserving every pre-Sprint-134
 *     order-creation caller's existing behavior unchanged;
 *   - shipping IS configured but nothing covers this specific cart/destination - a genuine
 *     customer-facing failure that must fail closed, never silently become free.
 * A missing requestedShippingMethodId auto-selects only when exactly one method is eligible
 * (mirroring the storefront's own safe-preselect allowance); with zero or multiple eligible
 * options and no explicit selection, this fails closed rather than guessing a hidden precedence.
 */
export function resolveFinalShipping(allMethods: ShippingMethodRecord[], activeMethods: ShippingMethodRecord[], input: FinalShippingResolutionInput): FinalShippingResolution {
  if (allMethods.length === 0) return { shippingMethodId: null, shippingMethodLabel: null, shippingAmountEurCents: 0 };

  const eligible = listEligibleShippingOptions(activeMethods, input);
  if (eligible.length === 0) throw new BadRequestError("No shipping method is available for this destination and cart");

  let selected: ResolvedShippingOption;
  if (input.requestedShippingMethodId) {
    const match = eligible.find((option) => option.shippingMethodId === input.requestedShippingMethodId);
    if (!match) throw new ConflictError("The selected shipping method is no longer available");
    selected = match;
  } else if (eligible.length === 1) {
    selected = eligible[0];
  } else {
    throw new BadRequestError("Shipping method selection is required");
  }

  if (input.expectedShippingAmountEurCents !== undefined && input.expectedShippingAmountEurCents !== selected.amountEurCents) {
    throw new ConflictError("Shipping cost has changed; please review your order before submitting again");
  }

  return { shippingMethodId: selected.shippingMethodId, shippingMethodLabel: selected.label, shippingAmountEurCents: selected.amountEurCents };
}

export function effectiveShippingProfile(profile: string | null | undefined): string {
  return profile ?? ProductShippingProfile.Standard;
}

/**
 * Sprint 134: public, non-mutating shipping-options quote - kept as a real Use Case (not inline in
 * the Service layer) so product lookup goes through the canonical repository method
 * (orderItems.write.validateProductReferences, the same one order creation itself uses) rather than
 * a second, parallel DB-access path. Authoritative product price/profile are always re-read here,
 * never trusted from the request. Advisory only: the final COD submission independently re-resolves
 * shipping inside its own checkout transaction (see resolveFinalShipping), so a stale quote can
 * never become the charged amount.
 */
export function getShippingOptionsUseCase(uow: UnitOfWork) {
  return {
    execute(input: ShippingQuoteRequest): Promise<{ items: ResolvedShippingOption[] }> {
      return uow.run(({ repositories }) => {
        const ids = input.items.map((item) => item.productId);
        const products = repositories.order.orderItems.write.validateProductReferences(ids) as unknown as Array<{ priceEur: number; wooListingPriceEur: number | null; shippingProfile: string | null }>;
        if (products.length !== ids.length) throw new NotFoundError("Product not found");
        const subtotalEurCents = products.reduce((sum, p) => sum + toEurCents(p.wooListingPriceEur ?? p.priceEur), 0);
        const effectiveProfiles = products.map((p) => effectiveShippingProfile(p.shippingProfile));
        const activeMethods = repositories.shippingMethods.listActive() as unknown as ShippingMethodRecord[];
        return { items: listEligibleShippingOptions(activeMethods, { subtotalEurCents, countryCode: input.countryCode, effectiveProfiles }) };
      });
    },
  };
}
