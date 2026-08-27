// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Header } from "@/components/Header";
import { SearchForm } from "@/components/SearchForm";

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={String(href)} {...props}>{children}</a> }));
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: navigation.push }) }));

describe("Sprint 154 Header", () => {
  afterEach(() => { cleanup(); navigation.push.mockReset(); });
  it("uses non-heading branding and exposes desktop search", () => {
    const { container } = render(<Header />);
    expect(container.querySelector("header h1")).toBeNull();
    expect(screen.getAllByRole("search").length).toBeGreaterThan(0);
  });

  it("exposes mobile search and closes on Escape with focus restoration", () => {
    render(<Header />);
    const trigger = screen.getByRole("button", { name: "Toggle navigation menu" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("navigation", { name: "Mobile navigation" }).querySelector("input")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("navigation", { name: "Mobile navigation" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes after mobile link activation", () => {
    render(<Header />);
    const trigger = screen.getByRole("button", { name: "Toggle navigation menu" });
    fireEvent.click(trigger);
    const mobile = screen.getByRole("navigation", { name: "Mobile navigation" });
    fireEvent.click(mobile.querySelector("a")!);
    expect(screen.queryByRole("navigation", { name: "Mobile navigation" })).toBeNull();
  });

  it("closes after mobile search submission", () => {
    render(<Header />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle navigation menu" }));
    const mobile = screen.getByRole("navigation", { name: "Mobile navigation" });
    fireEvent.change(within(mobile).getByRole("searchbox"), { target: { value: "brass clock" } });
    fireEvent.submit(within(mobile).getByRole("search"));
    expect(navigation.push).toHaveBeenCalledWith("/shop?search=brass%20clock");
    expect(screen.queryByRole("navigation", { name: "Mobile navigation" })).toBeNull();
  });
});

describe("Sprint 154 SearchForm", () => {
  afterEach(() => { cleanup(); navigation.push.mockReset(); });

  it("navigates a trimmed non-empty query with URL encoding", () => {
    render(<SearchForm />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "  brass & clock  " } });
    fireEvent.submit(screen.getByRole("search"));
    expect(navigation.push).toHaveBeenCalledWith("/shop?search=brass%20%26%20clock");
  });

  it("navigates whitespace-only searches to the unfiltered shop", () => {
    render(<SearchForm />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "   " } });
    fireEvent.submit(screen.getByRole("search"));
    expect(navigation.push).toHaveBeenCalledWith("/shop");
  });
});
