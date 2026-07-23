import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * Sprint 56B: real interactive lifecycle-action components (return/refund detail
 * pages) require @testing-library/react to render hooks/click behavior, unlike the
 * Sprint 55B page tests which walked plain server-rendered element trees. Without
 * this global cleanup, DOM from one test's render() call leaks into the next test
 * in the same file, since no setup file existed before this sprint.
 */
afterEach(() => {
  cleanup();
});
