import { describe, expect, it } from "vitest";
import { formatTelegramResponse, simplifyTelegramMarkdown } from "./telegram-formatting.mjs";

describe("telegram response formatting", () => {
  it("rewrites markdown tables into Telegram-friendly bullet details", () => {
    const input = [
      "**Workspace Exploration Summary**",
      "",
      "| Workspace | Repo Status | Current Stage | Selected Skills |",
      "|---|---|---|---|",
      "| coffee-browser | ✅ Active | 04_build | expo-ui, clerk |",
      "| next-bchvac | ⚠️ Intake | 02_intake | none yet |",
    ].join("\n");

    expect(formatTelegramResponse({ telegramFormatting: { enabled: true } }, input)).toBe([
      "Workspace Exploration Summary",
      "",
      "• coffee-browser",
      "  Repo Status: ✅ Active",
      "  Current Stage: 04_build",
      "  Selected Skills: expo-ui, clerk",
      "• next-bchvac",
      "  Repo Status: ⚠️ Intake",
      "  Current Stage: 02_intake",
      "  Selected Skills: none yet",
    ].join("\n"));
  });

  it("keeps fenced code intact while simplifying browser markdown outside code", () => {
    const input = [
      "### Result",
      "Use `npm test` and **ship it**.",
      "```ts",
      "const value = `keep backticks`;",
      "```",
    ].join("\n");

    expect(simplifyTelegramMarkdown(input)).toBe([
      "Result",
      "Use npm test and ship it.",
      "```",
      "const value = `keep backticks`;",
      "```",
    ].join("\n"));
  });

  it("can be disabled for raw PI WEB markdown", () => {
    const input = "**Raw** | table-ish";
    expect(formatTelegramResponse({ telegramFormatting: { enabled: false } }, input)).toBe(input);
  });
});
