# TPSTracer

An experimental OpenCode V2 GUI plugin that displays session and delegated-agent throughput.

## Status

The dashboard targets `@opencode/plugin` **2.2.0**. Its GUI API is experimental. Earlier Desktop checks confirmed plugin loading and active-subagent header behavior; complete Desktop validation of the latest bundle remains pending.

The package includes a valid no-op server entry in `src/index.ts`, exporting `id: "tpstracer"` and an empty `setup`. OpenCode requires this definition even for a GUI-only plugin; a missing default definition previously prevented both the server entry and GUI from loading. No backend work is performed.

## Install from npm

Once version 0.1.0 is published, install the package with OpenCode V2:

```sh
opencode plugin add @nicolas-labbe/opencode-tpstracer@latest
```

OpenCode installs the prebuilt GUI bundle; users do not need to clone this repository or compile the plugin. To check for and install future updates:

```sh
opencode plugin check
opencode plugin update @nicolas-labbe/opencode-tpstracer
```

Alternatively, add `"@nicolas-labbe/opencode-tpstracer@latest"` to the `plugins` array in your global `~/.config/opencode/opencode.json(c)`, preserving existing settings. The npm package name differs from the stable runtime plugin ID, `tpstracer`.

## Development

Development used Node 24.20.0 and npm 11.19.0. From the project directory:

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run pack:check
```

The production build generates `dist/gui-experimental.cjs` using the official preset. `pack:check` builds through the `prepack` lifecycle and inspects the package without publishing it, so a separate build can be skipped when checking the package. Dependencies are pinned, and `package-lock.json` is retained for reproducible installs.

Project-owned code, identifiers, comments, ordinary test fixtures and documentation use English. Intentional GUI translations and localization/verbatim-data tests are exceptions.

The npm distribution contains only `package.json`, this README, `LICENSE`, `src/index.ts` and `dist/gui-experimental.cjs`. The repository retains the complete source and tests. Internal working documentation and OpenSpec artifacts are not distributed or tracked in the public repository.

## Local Desktop setup

To install locally, add the project directory to the `plugins` array in your global `~/.config/opencode/opencode.json(c)` configuration, preserving all existing entries:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/tpstracer"]
}
```

This is an example entry, not a replacement for your complete configuration. OpenCode reloads configuration changes; use `npm run build -- --watch` while iterating on the bundle. No additional MCP server is required to run the plugin.

Within a session, click the header indicator, open the panel from the **+** menu, or search for **Open TPSTracer throughput** in the command palette. The command ID is `tpstracer.open`. After correcting a failed server entry, use `/reload` in the app to force a complete reload. Rebuilding only the GUI bundle does not rerun the server entry.

## Dashboard and agents

The interface defaults to **English**. The panel's language selector also offers **Español**, **Português (Brasil)**, **Français**, **Deutsch**, **Italiano**, **简体中文**, **日本語**, **한국어** and **العربية**. The preference is saved in plugin-scoped GUI storage and does not change OpenCode's language. Numbers follow the selected locale; task titles and model/agent names remain unchanged. Arabic uses plugin-scoped right-to-left layout with isolated technical values; the chart still runs from older responses on the left to newer responses on the right.

The redesigned dashboard opens in **Simple** mode: session selection, current activity/estimated delivery, observed TTFT, latest measured speed and weighted average. **Detailed** adds the token breakdown, trend, history, historical agent filters, subagent cards, model inventory and method notes. The mode is saved alongside language and live-estimate visibility; existing preferences default to Simple without losing other choices. Switching modes preserves detailed expansion and selection state without reloading metrics.

Session and language use themed selection popovers with keyboard navigation; live estimation uses a labelled switch. The toolbar omits redundant Throughput and healthy Connected labels, while keeping exceptional connection/partial/error feedback and refresh controls. Chevron icons share one baseline-independent SVG alignment. The current redesign has source/helper-test acceptance, not a complete rendered accessibility or narrow-layout certification.

Both modes provide light/dark surfaces and two main cards (**Latest response** and **Weighted average**). Detailed includes an SVG trend covering up to 30 responses and ten initial history rows. Technical explanations stay collapsed by default. Changing language neither reloads metrics nor resets expanded history.

The scope selector separates **Current session** from each delegated session and supports filtering by the actual agent recorded in responses. Built-in and custom agents are supported: the plugin does not require an agent named Orchestrator or infer that name from child sessions. Subagents appear in collapsible cards, six initially, with their tasks and individual metrics. Descendants are discovered through same-server `parentID` relationships, excluding forks. **Concurrent-agent TPS is never summed.** Unknown or partial data is explicitly identified.

The header automatically follows the working subagent with the most recent verified activity, displaying its name/task and current activity or explicitly estimated live TPS. It returns to Current session when none remains active. Completed measurements stay separately labelled as final; unavailable values never borrow another session's rate. Clicking opens the panel without changing its independent scope selection.

The hybrid meter adds a session-scoped activity row, observed TTFT, waiting/tool/retry states and a persisted control to hide estimated TPS while retaining activity and final metrics. Its three-second window estimates tokens from Unicode code points divided by four, excludes the seed chunk and requires at least 500 ms and two observation times. This measures approximate visible delivery, not provider tokens or GPU decoding; language, content and buffering can substantially affect it. Estimates never enter final averages, charts or history.

The header and panel share one session tree. Discovery starts even when the panel is closed, is paginated, and is limited to 100 descendants and 50 pages per parent. Child histories use a bounded-concurrency queue, and repeated events are coalesced. Controllers are released when the last consumer leaves, not merely when the panel closes. Activity includes tools and retries, not just provider generation.

### Calculations

- Primary provider-active TPS: `(output + reasoning) / ((streamed - created) / 1000)`.
- Secondary wall-clock TPS, including waits: `output / ((completed - created) / 1000)`.
- Weighted averages divide each metric's summed eligible token counts by its summed corresponding durations; individual rates are not averaged.
- Per-response details include model, output, reasoning, active time and total time.
- Reasoning is displayed separately; missing reasoning is shown as `—`, not zero.

`streamed` marks the end of the provider stream, before subsequent tool/subagent waits—not the first token. Official OpenCode 2.2.0 code uses millisecond differences. Active TPS excludes those post-stream waits but still includes initial latency/prefill and possible in-stream pauses: it is neither pure decode speed nor TTFT. The formula matches the CLI's per-step ingredients, not its full-turn grouping.

Without `streamed` or explicit reasoning usage, primary TPS is unavailable and is never silently replaced by the secondary metric. Coverage includes completed responses even when they cannot be measured; explicitly reported zero tokens with a valid duration are a valid sample.

**Models · all loaded sessions** lists models observed in the session and its descendants, with session/agent provenance, coverage and measured usage. It includes model switches and responses without measurable TPS. Its rates are weighted per model, not summed system throughput. Current session history remains isolated from other sessions.

## History and states

The header and panel share data by server and session. History is paginated and deduplicated; events update status/recency and schedule bounded reloads. Event counts are never token counts; only validated incremental output content feeds the separate live estimate. Connection changes renew the transport and invalidate stale events and responses.

Loading, empty, error, disconnected and partial-data states are explicit. A repeated cursor or the 200-page safety cap produces **partial history**, never a silently incomplete session total. Full reload cost scales with history size; incremental history updates are not yet implemented.

Exact instantaneous token throughput, provider-native TTFT, durable background capture and remote export are not included. Observed TTFT requires a matching step start and first nonempty output event; attaching mid-step cannot reconstruct it. The chart represents completed responses, not instantaneous speed. The plugin does not persist prompts or send external telemetry.

## Verification

Release preparation passed **326 automated tests across eighteen files**, the TypeScript check, the production build (241.95 kB CJS), and a five-file package dry run. An extracted-package smoke test loaded the server definition with its original ID. These checks do not establish complete Desktop behavior or GUI rendering correctness.

The ten-language interface has 196 typed strings per language. Rendered RTL, long-label layout, complete host preference persistence and professional native-language review remain unverified; automated catalog parity is not linguistic certification.

Before considering the integration fully verified:

1. Confirm that a compatible Desktop loads the plugin without errors.
2. Open a session and check the indicator, panel and data after a completed response.
3. Switch sessions and servers; verify metric isolation.
4. Disconnect and reconnect; verify recovery without stale data.
5. Compare a response against its server-reported tokens and timestamps.

## License

[MIT](LICENSE). Copyright (c) 2026 Nicolas Labbe. Third-party dependencies retain their respective licenses.
