import { beforeEach, describe, expect, it } from "vitest";
import {
  type CheckoutDraft,
  clearCheckoutDraft,
  emptyAddress,
  emptyCheckoutDraft,
  getCheckoutDraft,
  isCheckoutDraftValid,
  saveCheckoutDraft,
  validateCheckoutDraft,
} from "../src/lib/checkout";

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

function validDraft(overrides: Partial<CheckoutDraft> = {}): CheckoutDraft {
  return {
    contact: { email: "buyer@example.com" },
    customer: { firstName: "Jane", lastName: "Collector" },
    shippingAddress: {
      line1: "1 Rue de Paris",
      city: "Paris",
      postalCode: "75001",
      country: "France",
      countryCode: "FR",
    },
    billingSameAsShipping: true,
    updatedAt: "",
    ...overrides,
  };
}

describe("empty checkout draft", () => {
  it("has empty contact, customer, and shipping address fields", () => {
    expect(emptyCheckoutDraft.contact.email).toBe("");
    expect(emptyCheckoutDraft.customer.firstName).toBe("");
    expect(emptyCheckoutDraft.customer.lastName).toBe("");
    expect(emptyCheckoutDraft.shippingAddress).toEqual(emptyAddress);
    expect(emptyCheckoutDraft.billingSameAsShipping).toBe(true);
  });

  it("is not valid", () => {
    expect(isCheckoutDraftValid(emptyCheckoutDraft)).toBe(false);
  });
});

describe("checkout draft validation", () => {
  it("accepts a fully valid draft", () => {
    expect(validateCheckoutDraft(validDraft())).toEqual({});
    expect(isCheckoutDraftValid(validDraft())).toBe(true);
  });

  it("requires a valid email", () => {
    const errors = validateCheckoutDraft(validDraft({ contact: { email: "not-an-email" } }));
    expect(errors.email).toBeDefined();
  });

  it("requires first and last name", () => {
    const errors = validateCheckoutDraft(validDraft({ customer: { firstName: "", lastName: "" } }));
    expect(errors.firstName).toBeDefined();
    expect(errors.lastName).toBeDefined();
  });

  it("requires shipping address line 1, city, postal code, country", () => {
    const errors = validateCheckoutDraft(
      validDraft({
        shippingAddress: { line1: "", city: "", postalCode: "", country: "", countryCode: "FR" },
      }),
    );
    expect(errors.shippingAddress?.line1).toBeDefined();
    expect(errors.shippingAddress?.city).toBeDefined();
    expect(errors.shippingAddress?.postalCode).toBeDefined();
    expect(errors.shippingAddress?.country).toBeDefined();
  });

  it("requires a valid two-letter country code", () => {
    const errors = validateCheckoutDraft(
      validDraft({
        shippingAddress: {
          line1: "1 Rue de Paris",
          city: "Paris",
          postalCode: "75001",
          country: "France",
          countryCode: "FRA",
        },
      }),
    );
    expect(errors.shippingAddress?.countryCode).toBeDefined();
  });

  it("does not require phone", () => {
    const errors = validateCheckoutDraft(validDraft({ contact: { email: "buyer@example.com" } }));
    expect(errors.email).toBeUndefined();
  });

  it("does not require billing address when billingSameAsShipping is true", () => {
    const errors = validateCheckoutDraft(validDraft({ billingSameAsShipping: true }));
    expect(errors.billingAddress).toBeUndefined();
  });

  it("requires a valid billing address when billingSameAsShipping is false", () => {
    const errors = validateCheckoutDraft(
      validDraft({ billingSameAsShipping: false, billingAddress: undefined }),
    );
    expect(errors.billingAddress).toBeDefined();
    expect(errors.billingAddress?.line1).toBeDefined();
  });

  it("accepts a valid separate billing address", () => {
    const errors = validateCheckoutDraft(
      validDraft({
        billingSameAsShipping: false,
        billingAddress: {
          line1: "2 Oxford Street",
          city: "London",
          postalCode: "W1D 1BS",
          country: "United Kingdom",
          countryCode: "GB",
        },
      }),
    );
    expect(errors.billingAddress).toBeUndefined();
  });

  it("does not require a customer note", () => {
    const errors = validateCheckoutDraft(validDraft({ customerNote: undefined }));
    expect(errors).toEqual({});
  });
});

describe("checkout draft persistence", () => {
  beforeEach(() => {
    // @ts-expect-error -- assigning a minimal browser-like global for the test
    global.window = { localStorage: new MemoryStorage() };
  });

  it("saves and reads back a draft", () => {
    saveCheckoutDraft(validDraft());
    const draft = getCheckoutDraft();
    expect(draft.contact.email).toBe("buyer@example.com");
    expect(draft.customer.firstName).toBe("Jane");
  });

  it("stamps an updatedAt timestamp on save", () => {
    const saved = saveCheckoutDraft(validDraft());
    expect(saved.updatedAt).not.toBe("");
  });

  it("restores the draft after a simulated reload", () => {
    saveCheckoutDraft(validDraft({ customerNote: "Please wrap carefully" }));
    // Simulate reload: read again from the same underlying storage.
    const restored = getCheckoutDraft();
    expect(restored.customerNote).toBe("Please wrap carefully");
  });

  it("clears the draft", () => {
    saveCheckoutDraft(validDraft());
    clearCheckoutDraft();
    expect(getCheckoutDraft()).toEqual(emptyCheckoutDraft);
  });

  it("handles corrupt JSON safely, returning the empty draft", () => {
    (window as unknown as { localStorage: MemoryStorage }).localStorage.setItem(
      "noctella_checkout_draft",
      "{not valid json",
    );
    expect(getCheckoutDraft()).toEqual(emptyCheckoutDraft);
  });

  it("handles an invalid/incomplete stored shape safely", () => {
    (window as unknown as { localStorage: MemoryStorage }).localStorage.setItem(
      "noctella_checkout_draft",
      JSON.stringify({ contact: { email: "buyer@example.com" } }),
    );
    expect(getCheckoutDraft()).toEqual(emptyCheckoutDraft);
  });

  it("returns the empty draft when window is undefined (server-side render safety)", () => {
    // @ts-expect-error -- simulate SSR where window doesn't exist
    global.window = undefined;
    expect(getCheckoutDraft()).toEqual(emptyCheckoutDraft);
  });
});
