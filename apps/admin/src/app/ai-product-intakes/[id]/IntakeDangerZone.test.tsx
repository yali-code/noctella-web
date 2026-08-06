// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AiProductIntakeStatus } from "@noctella/shared";
import * as aiProductIntakesLib from "@/lib/aiProductIntakes";
import { IntakeDangerZone } from "./IntakeDangerZone";

afterEach(() => vi.restoreAllMocks());

describe("IntakeDangerZone (Sprint 97)", () => {
  it("renders nothing when the intake is not Open", () => {
    const { container } = render(
      <IntakeDangerZone intakeId="intake-1" intakeStatus={AiProductIntakeStatus.Applied} onIntakeChanged={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("requires explicit inline confirmation before cancelling, with an optional reason", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "cancel").mockResolvedValue({} as any);
    const onIntakeChanged = vi.fn().mockResolvedValue({});
    render(<IntakeDangerZone intakeId="intake-1" intakeStatus={AiProductIntakeStatus.Open} onIntakeChanged={onIntakeChanged} />);
    await user.click(screen.getByRole("button", { name: "Cancel Intake" }));
    expect(spy).not.toHaveBeenCalled();
    await user.type(screen.getByPlaceholderText("Cancellation reason (optional)"), "no longer needed");
    await user.click(screen.getByRole("button", { name: "Confirm Cancel" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("intake-1", "no longer needed"));
    expect(onIntakeChanged).toHaveBeenCalled();
  });

  it("cancels with no reason when none is provided", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(aiProductIntakesLib.aiProductIntakesApi, "cancel").mockResolvedValue({} as any);
    render(<IntakeDangerZone intakeId="intake-1" intakeStatus={AiProductIntakeStatus.Open} onIntakeChanged={vi.fn().mockResolvedValue({})} />);
    await user.click(screen.getByRole("button", { name: "Cancel Intake" }));
    await user.click(screen.getByRole("button", { name: "Confirm Cancel" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("intake-1", undefined));
  });
});
