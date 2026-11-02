/**
 * TPSTracer server part: minimal load entry.
 *
 * GUI-only plugin: no backend work here. The host requires the server
 * entry to export a default definition with an id and a setup function;
 * without it the plugin fails to load and the GUI bundle never attaches.
 * The `./gui-experimental` bundle declares no id: the host assigns this
 * server plugin's id (`ctx.id`).
 */

import type { Plugin } from "@opencode/plugin";

const definition = {
  id: "tpstracer",
  setup() {},
} satisfies Plugin.Plugin;

export default definition;
