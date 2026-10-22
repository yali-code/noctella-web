/**
 * Etsy listing form parity (Phase 1). Values mirror the Etsy Open API v3 listing vocabulary where it
 * is documented (who_made, when_made, is_supply, should_auto_renew); everything here is ERP-side
 * structure only - nothing is sent to Etsy until the Phase 4 publishing integration verifies each
 * field against the live API (see docs/etsy/ETSY-LISTING-FORM-PARITY.md).
 */

/** "Who made it?" - Etsy API `who_made`. */
export enum EtsyWhoMade {
  IDid = "i_did",
  SomeoneElse = "someone_else",
  Collective = "collective",
}
export const ETSY_WHO_MADE_VALUES: EtsyWhoMade[] = Object.values(EtsyWhoMade);

/** Renewal preference - Etsy API `should_auto_renew` (automatic = true). */
export enum EtsyRenewalOption {
  Automatic = "automatic",
  Manual = "manual",
}
export const ETSY_RENEWAL_OPTION_VALUES: EtsyRenewalOption[] = Object.values(EtsyRenewalOption);

/** Listing limits shown by the Etsy listing form; enforced at the ERP publish gate, never at draft save. */
export const ETSY_LISTING_LIMITS = Object.freeze({
  titleMaxLength: 140,
  tagsMax: 13,
  tagMaxLength: 20,
  materialsMax: 13,
  materialMaxLength: 45,
  /** Etsy inventory SKU length - verify against the live API in Phase 4. */
  skuMaxLength: 32,
  /** Etsy treats an item as vintage only when it is at least 20 years old. */
  vintageMinAgeYears: 20,
});

/** Etsy object identifiers (taxonomy, shop section, shipping/processing/return profiles) are positive integers kept as strings. */
export const ETSY_ID_PATTERN = /^[1-9][0-9]{0,18}$/;

export interface EtsyWhenMadeSpan {
  readonly kind: "made_to_order" | "decade" | "range" | "before";
  /** Earliest possible year (null = open-ended / not applicable). */
  readonly fromYear: number | null;
  /** Latest possible year (null = not applicable, e.g. made to order). */
  readonly toYear: number | null;
}

/**
 * Structural parser for "When was it made?" (Etsy API `when_made`). Accepts `made_to_order`,
 * decades/centuries (`1970s`, `1800s`), year ranges (`2020_2026`) and `before_YYYY`. The exact
 * current range values roll forward on Etsy's side, so they are validated by shape, not by a
 * hard-coded list; the Phase 4 integration must confirm the value against Etsy before sending.
 */
export function parseEtsyWhenMade(value: string): EtsyWhenMadeSpan | null {
  if (value === "made_to_order") return { kind: "made_to_order", fromYear: null, toYear: null };
  const decade = /^(1[0-9]|20)([0-9])0s$/.exec(value);
  if (decade) {
    const start = Number(`${decade[1]}${decade[2]}0`);
    // "1800s"/"1700s" are centuries on Etsy; "1990s" etc. are decades.
    const century = decade[2] === "0" && start % 100 === 0 && start < 1900;
    return { kind: "decade", fromYear: start, toYear: start + (century ? 99 : 9) };
  }
  const range = /^([12][0-9]{3})_([12][0-9]{3})$/.exec(value);
  if (range) {
    const from = Number(range[1]), to = Number(range[2]);
    return from <= to ? { kind: "range", fromYear: from, toYear: to } : null;
  }
  const before = /^before_([12][0-9]{3})$/.exec(value);
  if (before) return { kind: "before", fromYear: null, toYear: Number(before[1]) - 1 };
  return null;
}
