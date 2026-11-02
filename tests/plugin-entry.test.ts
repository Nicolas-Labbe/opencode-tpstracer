import { describe, expect, it } from "vitest";
import entry from "../src/index.js";

/**
 * Load-contract regression: the server entry must export a default
 * definition with an id and a setup function, otherwise the host refuses
 * the plugin (`PluginModule.LoadError`) and the GUI bundle never attaches.
 * (Resolution through the official `Host` resolver is verified out of band:
 * the `gui()` Vite preset used by vitest rejects `@opencode/*` imports that
 * are not GUI-provided modules.)
 */
describe("plugin server entry", () => {
  it("exports a default definition with id tpstracer and a setup function", () => {
    expect(entry.id).toBe("tpstracer");
    expect(typeof entry.setup).toBe("function");
  });
});
