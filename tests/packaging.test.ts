import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import entry from "../src/index.js";

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  name: string;
  version: string;
  license: string;
  exports: Record<string, string>;
  files: string[];
  publishConfig?: { access?: string; registry?: string };
  scripts?: Record<string, string>;
};

describe("npm packaging manifest", () => {
  it("publishes under the approved scoped name at version 0.1.1 with MIT", () => {
    expect(manifest.name).toBe("@nicolas-labbe/opencode-tpstracer");
    expect(manifest.version).toBe("0.1.1");
    expect(manifest.license).toBe("MIT");
  });

  it("keeps the runtime exports and narrows npm files to the distributed entries", () => {
    expect(manifest.exports).toEqual({
      ".": "./src/index.ts",
      "./gui-experimental": "./dist/gui-experimental.cjs",
    });
    expect(manifest.files).toEqual([
      "dist/gui-experimental.cjs",
      "src/index.ts",
    ]);
  });

  it("publishes publicly to the npm registry and builds the GUI bundle before packing", () => {
    expect(manifest.publishConfig).toEqual({
      access: "public",
      registry: "https://registry.npmjs.org",
    });
    expect(manifest.scripts?.prepack).toBe("npm run build");
    expect(manifest.scripts?.prepare).toBeUndefined();
    expect(manifest.scripts?.postinstall).toBeUndefined();
  });

  it("keeps the runtime plugin id unchanged for storage and command compatibility", () => {
    expect(entry.id).toBe("tpstracer");
    expect(typeof entry.setup).toBe("function");
  });
});
