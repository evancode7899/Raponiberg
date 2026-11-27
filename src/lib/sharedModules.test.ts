import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prismaClientIsShared } from "./sharedModules";

let tmp: string;
let main: string;
let worktree: string;
let links: string[];

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "pf-modules-test-"));
  main = path.join(tmp, "app");
  worktree = path.join(main, "worktrees", "example");
  links = [];
  mkdirSync(path.join(main, "node_modules", "@prisma", "client"), { recursive: true });
  mkdirSync(worktree, { recursive: true });
});
afterEach(() => {
  // Links first, so removing the folder never follows one.
  for (const l of links) rmSync(l, { force: true, recursive: false });
  rmSync(tmp, { recursive: true, force: true });
});

/** A junction on Windows (no admin rights needed), a directory link elsewhere. */
const link = (target: string, at: string) => {
  symlinkSync(target, at, "junction");
  links.unshift(at);
};

describe("prismaClientIsShared", () => {
  it("is false for a checkout with its own packages", () => {
    expect(prismaClientIsShared(main)).toBe(false);
  });

  it("is true when node_modules is a junction to another checkout's", () => {
    link(path.join(main, "node_modules"), path.join(worktree, "node_modules"));
    expect(prismaClientIsShared(worktree)).toBe(true);
  });

  it("is true with no packages of its own, or only a tool's cache folder", () => {
    expect(prismaClientIsShared(worktree)).toBe(true);
    mkdirSync(path.join(worktree, "node_modules", ".cache"), { recursive: true });
    expect(prismaClientIsShared(worktree)).toBe(true);
  });

  it("is false when the whole checkout is reached through a link", () => {
    const alias = path.join(tmp, "alias");
    link(main, alias);
    expect(prismaClientIsShared(alias)).toBe(false);
  });
});
