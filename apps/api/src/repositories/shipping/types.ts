/**
 * Sprint 134: Admin-configurable checkout-time shipping methods. countryCodes/shippingProfiles
 * are `null` to mean "unrestricted" (eligible for every country/profile) - never an empty array
 * meaning the same thing, to keep eligibility matching unambiguous.
 */
export interface ShippingMethodRecord {
  id: string;
  label: string;
  isActive: boolean;
  sortOrder: number;
  ruleType: string;
  flatAmountEurCents: number | null;
  freeThresholdEurCents: number | null;
  countryCodes: string[] | null;
  shippingProfiles: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateShippingMethodInput {
  id: string;
  label: string;
  isActive: boolean;
  sortOrder: number;
  ruleType: string;
  flatAmountEurCents: number | null;
  freeThresholdEurCents: number | null;
  countryCodes: string[] | null;
  shippingProfiles: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateShippingMethodInput {
  label?: string;
  isActive?: boolean;
  sortOrder?: number;
  ruleType?: string;
  flatAmountEurCents?: number | null;
  freeThresholdEurCents?: number | null;
  countryCodes?: string[] | null;
  shippingProfiles?: string[] | null;
  updatedAt: string;
}

export interface ShippingMethodRepository {
  /** Every row regardless of active state - used for Admin listing and to distinguish "shipping not yet configured at all" (legacy/bootstrap: zero rows ever created) from "configured but nothing matches this cart" (must fail closed). */
  list(): ShippingMethodRecord[] | Promise<ShippingMethodRecord[]>;
  /** Active rows only, in deterministic sortOrder - the authoritative resolution candidate set. */
  listActive(): ShippingMethodRecord[] | Promise<ShippingMethodRecord[]>;
  getById(id: string): ShippingMethodRecord | null | Promise<ShippingMethodRecord | null>;
  create(input: CreateShippingMethodInput): ShippingMethodRecord | Promise<ShippingMethodRecord>;
  update(id: string, input: UpdateShippingMethodInput): ShippingMethodRecord | null | Promise<ShippingMethodRecord | null>;
}
