import { describe, expect, it } from "vitest";
import { countLines, isCodeFile } from "./codeLines";

describe("isCodeFile", () => {
  it("keeps code and skips JSON, Markdown and images", () => {
    expect(isCodeFile("src/app/page.tsx")).toBe(true);
    expect(isCodeFile("scripts/setup.mjs")).toBe(true);
    expect(isCodeFile("prisma/schema.prisma")).toBe(true);
    expect(isCodeFile("package-lock.json")).toBe(false);
    expect(isCodeFile("README.md")).toBe(false);
    expect(isCodeFile("src/app/icon.svg")).toBe(false);
  });
});

describe("countLines", () => {
  it("counts a last line with or without its newline", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\nb")).toBe(2);
  });
});
