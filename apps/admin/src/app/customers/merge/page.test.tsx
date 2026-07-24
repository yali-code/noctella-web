// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as bridge from "@/lib/erpCustomerBridge";
import CustomerMergePage from "./page";

afterEach(() => vi.restoreAllMocks());

const candidateA = { customer: { id: "c1", name: "Ada", email: "ada@x.test" }, reasons: ["Email"] };
const candidateB = { customer: { id: "c2", name: "Ada B", email: "ada@x.test" }, reasons: ["Email", "Phone"] };

async function searchAndGetResults(user: ReturnType<typeof userEvent.setup>, candidates = [candidateA, candidateB]) {
  vi.spyOn(bridge, "searchMergeCandidates").mockResolvedValue({ candidates, autoMerge: false, executionRequired: true });
  await user.type(screen.getByPlaceholderText("Email"), "ada@x.test");
  await user.click(screen.getByText("Search"));
  await screen.findByText(/Ada \(c1\)/);
}

describe("Customer Merge page (Sprint 61B)", () => {
  it("shows only backend-supported search fields", async () => {
    render(<CustomerMergePage />);
    expect(screen.getByPlaceholderText("Email")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Phone")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("VAT number")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("ERP reference")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Marketplace buyer ID")).toBeInTheDocument();
  });

  it("submits only the non-empty fields entered, inventing no extra matching criteria", async () => {
    const user = userEvent.setup();
    const searchSpy = vi.spyOn(bridge, "searchMergeCandidates").mockResolvedValue({ candidates: [], autoMerge: false, executionRequired: true });
    render(<CustomerMergePage />);
    await user.type(screen.getByPlaceholderText("Email"), "ada@x.test");
    await user.type(screen.getByPlaceholderText("VAT number"), "VAT1");
    await user.click(screen.getByText("Search"));
    await waitFor(() => expect(searchSpy).toHaveBeenCalledWith({ email: "ada@x.test", vatNumber: "VAT1" }));
  });

  it("renders candidates with their visible match reasons", async () => {
    const user = userEvent.setup();
    render(<CustomerMergePage />);
    await searchAndGetResults(user);
    expect(screen.getByText(/Ada \(c1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Ada B \(c2\)/)).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Email" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Email, Phone" })).toBeInTheDocument();
  });

  it("shows a 'no candidates' message when the search returns none", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge, "searchMergeCandidates").mockResolvedValue({ candidates: [], autoMerge: false, executionRequired: true });
    render(<CustomerMergePage />);
    await user.click(screen.getByText("Search"));
    await screen.findByText("No matching candidates found.");
  });

  it("shows a graceful error when the search itself fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge, "searchMergeCandidates").mockRejectedValue(new Error("ERP authentication failed"));
    render(<CustomerMergePage />);
    await user.click(screen.getByText("Search"));
    await screen.findByText("ERP authentication failed");
  });

  it("allows selecting distinct source and target candidates, and only arms the merge once both are set", async () => {
    const user = userEvent.setup();
    render(<CustomerMergePage />);
    await searchAndGetResults(user);
    const mergeButton = screen.getByRole("button", { name: "Merge" });
    expect(mergeButton).toBeDisabled();
    const [sourceBtnA] = screen.getAllByText("Set as Source");
    await user.click(sourceBtnA);
    expect(mergeButton).toBeDisabled();
    const targetButtons = screen.getAllByText("Set as Target");
    await user.click(targetButtons[1]);
    expect(mergeButton).toBeEnabled();
    expect(screen.getByText("Source")).toBeInTheDocument();
    expect(screen.getByText("Target")).toBeInTheDocument();
  });

  async function armMerge(user: ReturnType<typeof userEvent.setup>) {
    await searchAndGetResults(user);
    await user.click(screen.getAllByText("Set as Source")[0]);
    await user.click(screen.getAllByText("Set as Target")[1]);
    await user.click(screen.getByRole("button", { name: "Merge" }));
  }

  it("requires explicit confirmation before executing the merge", async () => {
    const user = userEvent.setup();
    const mergeSpy = vi.spyOn(bridge, "executeMerge").mockResolvedValue({ status: "Completed", idempotent: false, sourceCustomerId: "c1", targetCustomerId: "c2" });
    render(<CustomerMergePage />);
    await armMerge(user);
    expect(mergeSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/Confirm merging c1 into c2/)).toBeInTheDocument();
    await user.click(screen.getByText("Confirm Merge"));
    await waitFor(() => expect(mergeSpy).toHaveBeenCalledTimes(1));
  });

  it("generates one idempotency key for the armed attempt and reuses it across a retry", async () => {
    const user = userEvent.setup();
    const mergeSpy = vi
      .spyOn(bridge, "executeMerge")
      .mockRejectedValueOnce(new Error("Temporary failure"))
      .mockResolvedValueOnce({ status: "Completed", idempotent: false, sourceCustomerId: "c1", targetCustomerId: "c2" });
    render(<CustomerMergePage />);
    await armMerge(user);
    await user.click(screen.getByText("Confirm Merge"));
    await screen.findByRole("alert");
    await user.click(screen.getByText("Confirm Merge"));
    await waitFor(() => expect(mergeSpy).toHaveBeenCalledTimes(2));
    const firstKey = mergeSpy.mock.calls[0][0].idempotencyKey;
    const secondKey = mergeSpy.mock.calls[1][0].idempotencyKey;
    expect(firstKey).toBe(secondKey);
    expect(mergeSpy.mock.calls[0][0]).toMatchObject({ sourceCustomerId: "c1", targetCustomerId: "c2" });
  });

  it("prevents a duplicate submission while a merge request is in flight", async () => {
    const user = userEvent.setup();
    let resolveMerge!: (v: any) => void;
    const mergeSpy = vi.spyOn(bridge, "executeMerge").mockReturnValue(new Promise((resolve) => { resolveMerge = resolve; }));
    render(<CustomerMergePage />);
    await armMerge(user);
    await user.click(screen.getByText("Confirm Merge"));
    expect(screen.getByText("Merging…")).toBeDisabled();
    await user.click(screen.getByText("Merging…"));
    expect(mergeSpy).toHaveBeenCalledTimes(1);
    resolveMerge({ status: "Completed", idempotent: false, sourceCustomerId: "c1", targetCustomerId: "c2" });
  });

  it("shows the backend's structured error message on failure", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge, "executeMerge").mockRejectedValue(new Error("Idempotency key was already used with a different payload"));
    render(<CustomerMergePage />);
    await armMerge(user);
    await user.click(screen.getByText("Confirm Merge"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Idempotency key was already used with a different payload");
  });

  it("shows a fresh-merge success message and refreshes candidates authoritatively", async () => {
    const user = userEvent.setup();
    const searchSpy = vi.spyOn(bridge, "searchMergeCandidates").mockResolvedValue({ candidates: [candidateA, candidateB], autoMerge: false, executionRequired: true });
    vi.spyOn(bridge, "executeMerge").mockResolvedValue({ status: "Completed", idempotent: false, sourceCustomerId: "c1", targetCustomerId: "c2" });
    render(<CustomerMergePage />);
    await user.type(screen.getByPlaceholderText("Email"), "ada@x.test");
    await user.click(screen.getByText("Search"));
    await screen.findByText(/Ada \(c1\)/);
    await user.click(screen.getAllByText("Set as Source")[0]);
    await user.click(screen.getAllByText("Set as Target")[1]);
    await user.click(screen.getByRole("button", { name: "Merge" }));
    await user.click(screen.getByText("Confirm Merge"));
    await screen.findByText(/Merge completed: c1 → c2\./);
    await waitFor(() => expect(searchSpy).toHaveBeenCalledTimes(2));
  });

  it("distinguishes an idempotent replay from a fresh merge when the backend reports one", async () => {
    const user = userEvent.setup();
    vi.spyOn(bridge, "executeMerge").mockResolvedValue({ status: "Completed", idempotent: true, sourceCustomerId: "c1", targetCustomerId: "c2" });
    render(<CustomerMergePage />);
    await armMerge(user);
    await user.click(screen.getByText("Confirm Merge"));
    await screen.findByText(/idempotent replay/);
  });

  it("resets the armed idempotency key when the source/target selection changes", async () => {
    const user = userEvent.setup();
    const mergeSpy = vi.spyOn(bridge, "executeMerge").mockResolvedValue({ status: "Completed", idempotent: false, sourceCustomerId: "c1", targetCustomerId: "c2" });
    render(<CustomerMergePage />);
    await armMerge(user);
    // Changing the target selection should disarm the merge and require re-arming/re-confirming.
    await user.click(screen.getAllByText("Unset Target")[0]);
    expect(screen.queryByText("Confirm Merge")).not.toBeInTheDocument();
    expect(mergeSpy).not.toHaveBeenCalled();
  });
});
