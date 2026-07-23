import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Sprint 55B: previously apps/admin had no vitest config at all, so the
 * `@/*` path alias (declared in tsconfig.json, used pervasively by Next.js
 * page/route files) did not resolve for Vitest, and .tsx files could not be
 * transformed at all (tsconfig.json correctly keeps "jsx": "preserve" for
 * Next.js's own build, which tells Vite to defer JSX transformation to a
 * plugin rather than transform it itself). This adds only the alias
 * resolution and JSX-transform plugin needed to make page/component tests
 * possible - no other Vitest behavior changes from the previous (implicit)
 * defaults.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
});
