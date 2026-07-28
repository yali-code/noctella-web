// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as lib from "@/lib/companyProfile";
import CompanyProfilePage from "./page";

afterEach(() => vi.restoreAllMocks());

describe("Company profile page (Sprint 79)", () => {
  it("shows the not-configured warning when no profile exists yet", async () => {
    vi.spyOn(lib.companyProfileApi, "get").mockResolvedValue({ configured: false });
    render(<CompanyProfilePage />);
    expect(await screen.findByText(/No company profile is configured yet/)).toBeInTheDocument();
  });

  it("loads and displays an existing profile's legal name", async () => {
    vi.spyOn(lib.companyProfileApi, "get").mockResolvedValue({ legalName: "Noctella Test Ltd.", registrationNumber: "T-1", addressLine1: "1 Row", city: "Town", postalCode: "0", country: "FR", email: "a@b.invalid", phone: "0", updatedAt: "t1" });
    render(<CompanyProfilePage />);
    const input = await screen.findByDisplayValue("Noctella Test Ltd.");
    expect(input).toBeInTheDocument();
  });

  it("saves edits by calling companyProfileApi.update with the edited fields", async () => {
    const user = userEvent.setup();
    vi.spyOn(lib.companyProfileApi, "get").mockResolvedValue({ legalName: "Noctella Test Ltd.", registrationNumber: "T-1", addressLine1: "1 Row", city: "Town", postalCode: "0", country: "FR", email: "a@b.invalid", phone: "0", updatedAt: "t1" });
    const updateSpy = vi.spyOn(lib.companyProfileApi, "update").mockResolvedValue({ legalName: "Noctella Renamed Ltd.", updatedAt: "t2" });
    render(<CompanyProfilePage />);
    const input = await screen.findByDisplayValue("Noctella Test Ltd.");
    await user.clear(input);
    await user.type(input, "Noctella Renamed Ltd.");
    await user.click(screen.getByText("Save Company Profile"));
    await waitFor(() => expect(updateSpy).toHaveBeenCalled());
    expect(updateSpy.mock.calls[0][0]).toMatchObject({ legalName: "Noctella Renamed Ltd.", expectedUpdatedAt: "t1" });
    expect(await screen.findByText("Company profile saved.")).toBeInTheDocument();
  });
});
