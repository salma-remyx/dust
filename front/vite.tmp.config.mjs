import path from "path";
import { defineConfig } from "vitest/config";
const FRONT = "/tmp/rr-salma-remyx-dust-jd5839rx/front";
export default defineConfig({
  test: {
    globals: true, environment: "node", root: FRONT,
    include: ["**/temporal/agent_loop/lib/behavioral_failures.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"], passWithNoTests: false,
  },
  resolve: { alias: { "@app": path.resolve(FRONT) } },
});
