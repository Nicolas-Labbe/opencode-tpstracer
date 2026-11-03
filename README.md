# TPSTracer

Session and subagent throughput for OpenCode Desktop: measured tokens per second, estimated live delivery, and response history in one dashboard.

[npm](https://www.npmjs.com/package/@nicolas-labbe/opencode-tpstracer) · [Report an issue](https://github.com/Nicolas-Labbe/opencode-tpstracer/issues) · [MIT license](LICENSE)

## Features

- **Session dashboard:** latest measured response speed, weighted averages, token breakdowns, and response history.
- **Live activity:** approximate visible-output TPS, observed time to first token (TTFT), and waiting, tool, and retry states.
- **Subagent visibility:** inspect delegated sessions individually; the header follows the most recently active subagent.
- **Simple and Detailed views:** start with the essentials, then expand into trends, model usage, and measurement details.
- **Ten languages:** English by default, with saved language and display preferences, light/dark surfaces, and plugin-scoped Arabic RTL support.
- **No external telemetry:** the plugin does not persist prompts or send measurements to an external service.

## Requirements

TPSTracer is an **experimental OpenCode V2 Desktop GUI plugin**, developed against `@opencode/plugin` **2.2.0**. Compatibility with other OpenCode releases is not guaranteed because the GUI API is experimental. It does not add a terminal dashboard.

No additional MCP server or provider credentials are required. Installation uses a prebuilt GUI bundle; you do not need to clone or build this repository to use it.

## Installation

Run:

```sh
opencode plugin add @nicolas-labbe/opencode-tpstracer@latest
```

Alternatively, add the package to `plugins` in your global `~/.config/opencode/opencode.jsonc` (or `opencode.json`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@nicolas-labbe/opencode-tpstracer@latest"]
}
```

Merge this entry with your existing configuration rather than replacing other plugins or settings. OpenCode reloads configuration changes automatically. See the [OpenCode V2 plugin guide](https://opencode.ai/v2/docs/plugins) for configuration details.

### Updates

```sh
opencode plugin check
opencode plugin update @nicolas-labbe/opencode-tpstracer
```

`latest` points to the current published release; it does not track commits on GitHub.

## Usage

1. Open a session in OpenCode Desktop.
2. Open **TPSTracer** from the session side panel's **+** menu, click the header indicator, or search for **Open TPSTracer throughput** in the command palette.
3. Select **Current session** or a delegated session to inspect its measurements. Completed-response metrics appear when the required usage and timing data are available.
4. Switch from **Simple** to **Detailed** for token breakdowns, trends, response history, agent filters, and model usage.

The header follows the working subagent with the most recent verified activity and returns to **Current session** when none remains active. The panel keeps its own session selection. Built-in and custom agent names are displayed as recorded; no special agent configuration is required.

The command ID is `tpstracer.open`. The runtime plugin ID remains `tpstracer`, independently of its npm package name.

### Preferences and languages

Use the panel controls to choose a language, switch views, or hide the live TPS estimate. Hiding the estimate keeps activity, observed TTFT, and completed-response measurements visible. Language, view mode, and estimate visibility are saved in plugin-scoped GUI storage without changing OpenCode's language.

Supported languages: **English**, **Español**, **Português (Brasil)**, **Français**, **Deutsch**, **Italiano**, **简体中文**, **日本語**, **한국어**, and **العربية**.

Numbers follow the selected locale; task titles and model/agent names remain unchanged. Arabic uses RTL layout within the plugin, while technical values are isolated and charts retain older-left/newer-right order. Changing language or view mode does not reload metrics.

## Understanding the metrics

### Completed-response measurements

| Metric | Calculation |
| --- | --- |
| Provider-active TPS (primary) | `(output + reasoning) / ((streamed - created) / 1000)` |
| Wall-clock TPS (secondary) | `output / ((completed - created) / 1000)` |

Timestamps are in milliseconds. **`streamed` is the end of the provider stream, not the first token.** Provider-active time excludes subsequent tool/subagent waits, but still includes initial latency, prefill, and possible in-stream pauses. It is not pure GPU decoding speed or TTFT. Wall-clock time includes the waits between response creation and completion.

- Weighted rates use summed eligible token counts divided by their matching summed durations, not an arithmetic mean of individual rates.
- **Concurrent-agent TPS is never summed.** Sessions and servers remain isolated, and delegated sessions are discovered through same-server parent relationships, excluding forks.
- Output and reasoning are reported separately. Missing usage stays unavailable; it is not invented or treated as zero.
- Without the required timing or explicit reasoning usage, primary TPS is unavailable and is never silently replaced by the secondary metric. Explicitly reported zero tokens with a valid duration are a valid measurement.
- Trends show completed responses, not instantaneous generation speed. Model-level rates are weighted measurements, not summed system throughput.

### Live estimates and observed TTFT

Live TPS approximates visible output using **Unicode code points divided by four** over a three-second window. It excludes the initial seed chunk and requires at least 500 ms and two observation times before showing an estimate.

This is **not provider-reported token usage**. Language, content, and stream buffering can substantially affect the result. Estimates never enter completed-response averages, charts, or history; event counts are not token counts.

Observed TTFT measures the interval from a matching step start to the first nonempty output event seen by the plugin. It is a local observation, not provider-native TTFT. Attaching mid-step cannot reconstruct an earlier start or first output.

## Limitations

- The GUI integration is experimental. Earlier Desktop checks confirmed loading and active-subagent behavior, but complete validation of the latest bundle remains pending.
- Measurements depend on the usage and timestamps OpenCode exposes. Missing or partial history is labelled explicitly rather than presented as a complete total.
- Live delivery is approximate; exact instantaneous token throughput, durable background capture, and remote export are not provided.
- Full history reloads can become expensive for long sessions; incremental history updates are not yet implemented.
- Rendered Arabic RTL, long-label layouts, complete host preference persistence, and accessibility have not been comprehensively verified. Translations have automated consistency checks, not professional native-language certification.

## Development

Clone the repository and use npm with the committed lockfile. The development baseline is Node **24.20.0** and npm **11.19.0**.

```sh
git clone https://github.com/Nicolas-Labbe/opencode-tpstracer.git
cd opencode-tpstracer
npm ci
npm test
npm run typecheck
npm run pack:check
```

`pack:check` builds the GUI through the `prepack` lifecycle, then previews the package without publishing it. For a standalone build, run `npm run build`. The official OpenCode Vite preset produces one `dist/gui-experimental.cjs` bundle. The minimal server entry in `src/index.ts` provides the runtime plugin ID and performs no backend work.

The repository includes source and tests. The npm package contains only the two runtime entries, `package.json`, `README.md`, and `LICENSE`.

### Local development in Desktop

After building, add the absolute project directory instead of the npm entry to your global OpenCode `plugins` array. For example:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-tpstracer"]
}
```

Use your own path and preserve unrelated settings. Avoid configuring both the local and npm copies at once. Run `npm run build -- --watch` to rebuild while developing.

Before submitting changes, run the tests, TypeScript check, and package check above. These automated checks do not replace Desktop testing. Keep project-owned code and documentation in English; intentional UI translations and localization tests are exceptions.

## Support

Report bugs or suggest improvements through [GitHub Issues](https://github.com/Nicolas-Labbe/opencode-tpstracer/issues). Include your OpenCode version, plugin version, reproduction steps, and expected versus actual behavior. Redact credentials, prompts, task titles, and other private data from logs or screenshots.

## License

[MIT](LICENSE). Copyright (c) 2026 Nicolas Labbe. Third-party dependencies retain their respective licenses.
