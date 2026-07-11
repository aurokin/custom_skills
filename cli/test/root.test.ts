// `skm root` machine-config editing: list/add/remove with validation.

import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { configPath } from "../src/env";
import { runRoot } from "../src/root";
import type { Root, VerbOptions } from "../src/types";
import { type Sandbox, makeRoot, makeSandbox } from "./util";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => {
  sb.cleanup();
});

function opts(args: string[]): VerbOptions {
  return { json: true, prune: false, yes: false, fix: false, args };
}

test("root list seeds the built-in public repo root when no config exists", async () => {
  const out = await runRoot(sb.env, opts(["list"]));
  const roots = (out.json as { roots: Root[] }).roots;
  expect(roots.length).toBe(1);
  expect(roots[0]!.name).toBe("public");
  expect(roots[0]!.visibility).toBe("public");
});

test("root add validates and registers a private overlay root", async () => {
  const overlay = makeRoot(sb, "overlay", "private"); // creates skills/ dir

  const added = await runRoot(sb.env, opts(["add", overlay.path, "private"]));
  const roots = (added.json as { roots: Root[] }).roots;
  expect(roots.some((r) => r.name === "overlay" && r.visibility === "private")).toBe(true);

  // Persisted to the config file.
  const cfg = JSON.parse(fs.readFileSync(configPath(sb.env), "utf8"));
  expect(cfg.roots.some((r: Root) => r.path === overlay.path)).toBe(true);

  // Removing it works by name.
  const removed = await runRoot(sb.env, opts(["remove", "overlay"]));
  expect((removed.json as { roots: Root[] }).roots.some((r) => r.name === "overlay")).toBe(false);
});

test("root add rejects a path that does not exist", async () => {
  await expect(runRoot(sb.env, opts(["add", path.join(sb.base, "ghost")]))).rejects.toThrow(/does not exist/);
});

test("root add rejects a path without a skills/ directory", async () => {
  const bare = path.join(sb.base, "bare");
  fs.mkdirSync(bare, { recursive: true });
  await expect(runRoot(sb.env, opts(["add", bare]))).rejects.toThrow(/no skills\//);
});

test("root remove errors when nothing matches", async () => {
  await expect(runRoot(sb.env, opts(["remove", "nope"]))).rejects.toThrow(/no registered root/);
});
