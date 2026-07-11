const STORAGE_KEY = "noctella_checkout_draft";

export interface Address {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
  countryCode: string;
}

export interface ContactInfo {
  email: string;
  phone?: string;
}

export interface CustomerInfo {
  firstName: string;
  lastName: string;
  company?: string;
}

export interface CheckoutDraft {
  contact: ContactInfo;
  customer: CustomerInfo;
  shippingAddress: Address;
  billingSameAsShipping: boolean;
  billingAddress?: Address;
  customerNote?: string;
  updatedAt: string;
}

export const emptyAddress: Address = {
  line1: "",
  city: "",
  postalCode: "",
  country: "",
  countryCode: "",
};

export const emptyCheckoutDraft: CheckoutDraft = {
  contact: { email: "" },
  customer: { firstName: "", lastName: "" },
  shippingAddress: { ...emptyAddress },
  billingSameAsShipping: true,
  updatedAt: "",
};

/**
 * Initial supported sales markets: EU member states, United States, Canada,
 * United Kingdom. Used to populate the country select — no separate
 * eligibility/tax/shipping logic is implied beyond offering these choices.
 */
export const SUPPORTED_COUNTRIES: Array<{ name: string; code: string }> = [
  { name: "Austria", code: "AT" },
  { name: "Belgium", code: "BE" },
  { name: "Bulgaria", code: "BG" },
  { name: "Croatia", code: "HR" },
  { name: "Cyprus", code: "CY" },
  { name: "Czechia", code: "CZ" },
  { name: "Denmark", code: "DK" },
  { name: "Estonia", code: "EE" },
  { name: "Finland", code: "FI" },
  { name: "France", code: "FR" },
  { name: "Germany", code: "DE" },
  { name: "Greece", code: "GR" },
  { name: "Hungary", code: "HU" },
  { name: "Ireland", code: "IE" },
  { name: "Italy", code: "IT" },
  { name: "Latvia", code: "LV" },
  { name: "Lithuania", code: "LT" },
  { name: "Luxembourg", code: "LU" },
  { name: "Malta", code: "MT" },
  { name: "Netherlands", code: "NL" },
  { name: "Poland", code: "PL" },
  { name: "Portugal", code: "PT" },
  { name: "Romania", code: "RO" },
  { name: "Slovakia", code: "SK" },
  { name: "Slovenia", code: "SI" },
  { name: "Spain", code: "ES" },
  { name: "Sweden", code: "SE" },
  { name: "United States", code: "US" },
  { name: "Canada", code: "CA" },
  { name: "United Kingdom", code: "GB" },
];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COUNTRY_CODE_PATTERN = /^[A-Za-z]{2}$/;

export interface AddressErrors {
  line1?: string;
  city?: string;
  postalCode?: string;
  country?: string;
  countryCode?: string;
}

export interface CheckoutFormErrors {
  email?: string;
  firstName?: string;
  lastName?: string;
  shippingAddress?: AddressErrors;
  billingAddress?: AddressErrors;
}

function validateAddress(address: Address): AddressErrors {
  const errors: AddressErrors = {};
  if (!address.line1.trim()) errors.line1 = "Address line 1 is required";
  if (!address.city.trim()) errors.city = "City is required";
  if (!address.postalCode.trim()) errors.postalCode = "Postal code is required";
  if (!address.country.trim()) errors.country = "Country is required";
  if (!COUNTRY_CODE_PATTERN.test(address.countryCode.trim())) {
    errors.countryCode = "A valid two-letter country code is required";
  }
  return errors;
}

function isAddressErrorsEmpty(errors: AddressErrors): boolean {
  return Object.keys(errors).length === 0;
}

/**
 * Pure validation — email format, required name/address fields, two-letter
 * country code, and billing address required only when it differs from
 * shipping. Phone and customer note are always optional.
 */
export function validateCheckoutDraft(draft: CheckoutDraft): CheckoutFormErrors {
  const errors: CheckoutFormErrors = {};

  if (!EMAIL_PATTERN.test(draft.contact.email.trim())) {
    errors.email = "A valid email is required";
  }
  if (!draft.customer.firstName.trim()) {
    errors.firstName = "First name is required";
  }
  if (!draft.customer.lastName.trim()) {
    errors.lastName = "Last name is required";
  }

  const shippingErrors = validateAddress(draft.shippingAddress);
  if (!isAddressErrorsEmpty(shippingErrors)) {
    errors.shippingAddress = shippingErrors;
  }

  if (!draft.billingSameAsShipping) {
    const billingErrors = validateAddress(draft.billingAddress ?? emptyAddress);
    if (!isAddressErrorsEmpty(billingErrors)) {
      errors.billingAddress = billingErrors;
    }
  }

  return errors;
}

export function isCheckoutDraftValid(draft: CheckoutDraft): boolean {
  return Object.keys(validateCheckoutDraft(draft)).length === 0;
}

function isValidAddressShape(value: unknown): value is Address {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.line1 === "string" &&
    typeof v.city === "string" &&
    typeof v.postalCode === "string" &&
    typeof v.country === "string" &&
    typeof v.countryCode === "string" &&
    (v.line2 === undefined || typeof v.line2 === "string") &&
    (v.state === undefined || typeof v.state === "string")
  );
}

function isValidCheckoutDraftShape(value: unknown): value is CheckoutDraft {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const contact = v.contact as Record<string, unknown> | undefined;
  const customer = v.customer as Record<string, unknown> | undefined;
  return (
    typeof contact === "object" &&
    contact !== null &&
    typeof contact.email === "string" &&
    (contact.phone === undefined || typeof contact.phone === "string") &&
    typeof customer === "object" &&
    customer !== null &&
    typeof customer.firstName === "string" &&
    typeof customer.lastName === "string" &&
    (customer.company === undefined || typeof customer.company === "string") &&
    isValidAddressShape(v.shippingAddress) &&
    typeof v.billingSameAsShipping === "boolean" &&
    (v.billingAddress === undefined || isValidAddressShape(v.billingAddress)) &&
    (v.customerNote === undefined || typeof v.customerNote === "string") &&
    typeof v.updatedAt === "string"
  );
}

/** localStorage-backed wrapper — no backend persistence, no payment data. */
export function getCheckoutDraft(): CheckoutDraft {
  if (typeof window === "undefined") return emptyCheckoutDraft;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyCheckoutDraft;
    const parsed = JSON.parse(raw);
    if (!isValidCheckoutDraftShape(parsed)) {
      window.localStorage.removeItem(STORAGE_KEY);
      return emptyCheckoutDraft;
    }
    return parsed;
  } catch {
    if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
    return emptyCheckoutDraft;
  }
}

export function saveCheckoutDraft(draft: CheckoutDraft): CheckoutDraft {
  const withTimestamp: CheckoutDraft = { ...draft, updatedAt: new Date().toISOString() };
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(withTimestamp));
  }
  return withTimestamp;
}

export function clearCheckoutDraft(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}
