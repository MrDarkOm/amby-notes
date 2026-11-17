import js from "@eslint/js"
import tseslint from "typescript-eslint"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import prettier from "eslint-config-prettier"
import globals from "globals"

export default tseslint.config(
  {
    // Generated bindings, build output, and the Rust crate are out of scope.
    ignores: [
      "dist",
      "build/site",
      ".release-evidence",
      ".claude",
      "src-tauri",
      "sync/reference/.venv",
      "node_modules",
      "src/lib/bindings.ts",
      "*.config.js",
      "*.config.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    // Registered by stable rule name so this config survives plugin major bumps
    // (the preset export shapes differ between react-hooks v5 and v6).
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // Pre-existing debt on a previously unlinted codebase: keep these as
      // warnings so the gate is usable. The pre-commit hook only blocks on
      // staged files, so new/changed code is still held to the bar.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Enter that confirms an IME composition must not fire actions (WebKit sends it
    // with isComposing=false, keyCode 229). Use isEnterKey() from src/lib/keyboard.ts.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/keyboard.ts", "**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "BinaryExpression[operator=/^[!=]==?$/]:has(MemberExpression[property.name=/^(key|code)$/]):has(Literal[value='Enter'])",
          message:
            'Do not compare event.key/code with "Enter" directly: it fires during IME composition. Use isEnterKey(event) from "@/lib/keyboard".',
        },
        {
          // A destructured `key`/`code`: `const { key } = event; if (key === "Enter")`.
          selector:
            "BinaryExpression[operator=/^[!=]==?$/]:matches([left.type='Identifier'][left.name=/^(key|code)$/][right.value='Enter'], [right.type='Identifier'][right.name=/^(key|code)$/][left.value='Enter'])",
          message:
            'Do not compare key/code with "Enter" directly: it fires during IME composition. Use isEnterKey(event) from "@/lib/keyboard".',
        },
        {
          // `switch (event.key) { case "Enter": ... }`
          selector: "SwitchCase[test.value='Enter']",
          message:
            'Do not switch on "Enter" directly: it fires during IME composition. Test isEnterKey(event) from "@/lib/keyboard" before the switch.',
        },
      ],
    },
  },
  prettier,
)
