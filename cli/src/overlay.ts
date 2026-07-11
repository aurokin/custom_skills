// Overlay scoping: reads <root>/overlay.json for overlay (typically private)
// roots. Owned by the resolve team. Reuses the shared scoping-source validator
// in catalog.ts; an absent overlay file means the root contributes only
// unscoped skills.

import * as fs from "node:fs";
import * as path from "node:path";
import { loadScopingSource } from "./catalog";
import type { Registry, Root, ScopingSource } from "./types";

/** Path to a root's overlay manifest. */
export function overlayPath(root: Root): string {
  return path.join(root.path, "overlay.json");
}

/**
 * Load a root's overlay manifest, or undefined when it has none. Validates
 * version + scoping shape (allow XOR deny per skill) and, when `reg` is given,
 * that referenced agent ids exist. An overlay with no `skills` key yields a
 * source whose skills map is empty (every skill unscoped).
 */
export function loadOverlay(root: Root, reg?: Registry): ScopingSource | undefined {
  const file = overlayPath(root);
  if (!fs.existsSync(file)) return undefined;
  return loadScopingSource(file, reg);
}
