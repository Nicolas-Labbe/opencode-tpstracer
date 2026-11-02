/**
 * Persisted GUI preference schema.
 *
 * `liveEstimate` and `viewMode` were added after the original language-only
 * preference. `withDecodingDefaultKey` makes each encoded key optional while
 * decoding a missing value to its current default, so an existing
 * `{ language: "es" }` store keeps Spanish and gains enabled estimates and
 * Simple detail instead of failing or dropping the language. Explicit values,
 * including `liveEstimate: false`, `viewMode: "detailed"` and every supported
 * language, are preserved.
 *
 * The literal list mirrors `LANGUAGES` in definition.ts. It stays local so the
 * schema can be decoded by the plain Node strip-types test harness without a
 * runtime metadata import; decode tests cover every canonical identifier.
 */

import { Effect, Schema } from "effect";

export const ViewModeSchema = Schema.Literals(["simple", "detailed"]).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed("simple")),
);

export const PrefsSchema = Schema.Struct({
  language: Schema.Literals(["en", "es", "pt", "fr", "de", "it", "zh-CN", "ja", "ko", "ar"]),
  liveEstimate: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  viewMode: ViewModeSchema,
});

export type Prefs = Schema.Schema.Type<typeof PrefsSchema>;

export const DEFAULT_PREFS: Prefs = { language: "en", liveEstimate: true, viewMode: "simple" };
