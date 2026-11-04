import { describe, expect, it } from "vitest";
import { buildAiIntakeGenerationContext } from "../src/ai-intake/context";
import { DeterministicAiIntakePromptBuilder } from "../src/ai-intake/promptBuilder";
import { assertIntakeReadyForGenerationUseCase, updateIntakeWarehouseFactsUseCase } from "../src/use-cases/ai-product-intake/useCases";
import { updateIntakeWarehouseFactsSchema } from "../src/validation/aiProductIntake";

const intake = { id: "i1", status: "open", createdByAdminUserId: "a", createdAt: "t", updatedAt: "t" } as any;

describe("intake warehouse facts", () => {
  it("blocks generation until a condition is declared", () => {
    expect(() => assertIntakeReadyForGenerationUseCase({})).toThrow(/warehouse condition/);
    expect(() => assertIntakeReadyForGenerationUseCase({ declaredCondition: "Used" })).not.toThrow();
  });

  it("passes the facts to the prompt as authoritative", () => {
    const context = buildAiIntakeGenerationContext({ ...intake, declaredCondition: "For parts", testNote: "Does not power on" }, []);
    const { userPrompt } = new DeterministicAiIntakePromptBuilder().build(context);
    expect(userPrompt).toContain("Warehouse-declared condition (authoritative, never contradict it): For parts");
    expect(userPrompt).toContain("Warehouse test note (authoritative): Does not power on");
    expect(userPrompt).toContain("only if the warehouse test note states them");
  });

  it("forbids working claims when there is no test note", () => {
    const context = buildAiIntakeGenerationContext({ ...intake, declaredCondition: "Used" }, []);
    const { userPrompt } = new DeterministicAiIntakePromptBuilder().build(context);
    expect(userPrompt).toContain("No warehouse test note was given.");
  });

  it("validates the condition and normalizes an empty note", () => {
    expect(updateIntakeWarehouseFactsSchema.safeParse({ declaredCondition: "Broken" }).success).toBe(false);
    expect(updateIntakeWarehouseFactsSchema.safeParse({}).success).toBe(false);
    expect(updateIntakeWarehouseFactsSchema.safeParse({ declaredCondition: "Used", extra: 1 }).success).toBe(false);
    expect(updateIntakeWarehouseFactsSchema.parse({ declaredCondition: "Used", testNote: "  " }).testNote).toBeNull();
  });

  it("rejects changes once the intake is no longer Open", async () => {
    const repository = {
      updateWarehouseFactsWithExpectedState: async () => ({
        updated: false,
        conflict: { field: "status", message: 'Expected status "open" but found "applied"' },
      }),
    } as any;
    await expect(updateIntakeWarehouseFactsUseCase(repository, { id: "i1", declaredCondition: "Used", testNote: null })).rejects.toThrow(/found "applied"/);
  });
});
