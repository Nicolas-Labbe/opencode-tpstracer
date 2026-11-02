import { defineConfig } from "vite";
import { gui } from "@opencode/plugin/gui/vite";

export default defineConfig({
  plugins: [gui()],
  // Pure Node unit tests: opt out of vite-plugin-solid's jsdom default.
  test: { environment: "node" },
});
