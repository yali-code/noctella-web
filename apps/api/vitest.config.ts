import path from "node:path";
import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@noctella/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    // Sprint 53B: tests/build-copy.test.mjs uses node:test (not Vitest) and runs
    // exclusively via `npm run test:build-copy`. Vitest's default include glob
    // would otherwise also pick it up and report it as a failed suite.
    exclude: [...defaultExclude, "tests/build-copy.test.mjs"],
  },
});
