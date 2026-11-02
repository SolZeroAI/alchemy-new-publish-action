import { defineConfig } from "oxlint"
import { agentToolIgnorePatterns, recommended } from "oxlint-plugin-solzero/config"

export default defineConfig({
  extends: [recommended],
  // A disable comment that suppresses nothing fails lint, so stale suppressions cannot pile up.
  options: { reportUnusedDisableDirectives: "error" },
  plugins: ["unicorn", "typescript", "oxc"],
  ignorePatterns: [...agentToolIgnorePatterns, "**/dist/**", "**/fixtures/**"],
  rules: {
    "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],
  },
})
