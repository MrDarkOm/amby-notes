# Interface emoji

Amby uses local Google Noto Emoji for **standalone interface icons**. Ordinary
Markdown, Source, Canvas, Sketch and AI chat text retain system rendering.
Lucide, custom images, document formats, user-selected colours and icon values
are unchanged. An icon choice is still the original Unicode string, never an
asset path. Rendering does not write user data.

## Ownership

- `src/lib/emoji/manifest.json`: generated Unicode 18.0 sequence-to-image map.
- `src/lib/emoji/emoji-resolver.ts`: exact lookups, original leading sequences
  for callouts, local picker URLs and unsupported-sequence fallback.
- `src/components/ui/emoji-glyph.tsx`: decorative local image with native text
  fallback on missing coverage or load failure. Accessible control labels remain
  on their existing buttons. Sizes inherit the slot's current font size.
- `IconValue`, tree icons, callout icons and attachment fallback use this renderer.
  Consumers of `IconValue` include tabs, page titles, folders, properties, database
  views/relations, navigation, history/archive and note cards in Canvas/Sketch.
- `src/lib/emoji/picker-data.ts`: preserves Emoji Mart's existing IDs, aliases,
  categories and skin ordering. Adds newer Unicode entries and local `src` for
  every skin. Mart 5.6 hardcodes spritesheets inside the Picker, so its top-level
  `getImageURL` option alone does not work here. Per-skin `src` takes precedence.
  A capture-phase shadow-root error handler restores native text if an image fails;
  it is detached when the retained picker is disposed.
- `src/lib/emoji/picker-styles.ts` waits for Mart's asynchronous initial root and
  inserts an external bundled CSS link. This survives packaged CSP configurations
  that disallow constructor-injected inline styles. A one-shot child-list observer
  disconnects immediately after initialization; searches and scrolling are not observed.
- `src/themes/app.css` and `emoji-mart-base.css`: visual definitions. The picker's
  hardcoded loupe is replaced by a local mask matching the installed Lucide Search
  geometry, with its ISC notice. Search font, field size and transparent focused
  background match the Icons tab; a regression test compares computed styles.

## Picker lifetime and opening cost

`src/lib/emoji/picker-runtime.ts` retains one picker for the current language,
translated UI labels and light/dark mode. `EmojiPickerWarmup` mounts only after
hydrated preferences and startup gates. It warms the grid during `requestIdleCallback`
(with a cancellable timer fallback), including local styles and visible image loads.
Cold clicks defer construction by one animation frame, so StrictMode's discarded
mount can cancel before constructing another picker.

The owned `amby-emoji-picker` custom element subclasses Mart's picker. On its first
connection it calls the normal Mart lifecycle. Moving the retained element between
its active mount and the hidden parking place leaves the component mounted; final
disposal calls Mart's normal disconnect. No private component fields/methods are
used. The retained library observers and document-click handler are bounded to this
one grid and are removed on disposal. Parking uses `visibility: hidden`, disabled
pointer interaction and `aria-hidden`; background warming does not steal focus from the editor.

Each mount replaces the selection/close callbacks. Closing clears those references,
resets the query through the input event API and refreshes recent choices through
Mart's public categories update while hidden. A new language/theme/label set disposes
the old grid; opening another owner closes the previous owner. Old cleanup cannot
move a newer owner's picker. HMR also disposes the cached DOM and listeners.

Acceptance tests cover a single retained grid, StrictMode cancellation, language/theme
invalidation, owner handover, correct note selection, recent choices, cleared searches
and focus preservation. This trades a bounded hidden grid (about 180 visible-category
images in the measured viewport) for avoiding recreation on every opening. Builds
still use only local resources; warming changes no note or preference data.

## Multilingual search

Search always includes English plus the **current application language**. Russian
uses 3,963 local Unicode CLDR 49 entries (base and derived annotations). Switching
the app to English removes Russian-only keywords; switching back restores them.
Unknown/unregistered locales retain English. Regional tags inherit their base
language (e.g. `ru-RU` uses `ru`); they may add a regional pack as well.

- `src/locales/emoji-search.ts`: typed registry of bundled language packs.
- `src/locales/emoji-search/ru.json`: pinned Russian vocabulary and input checksums.
- `src/lib/emoji/search-keywords.ts`: pure language selection and keyword merge.
- `src/lib/emoji/picker-search.ts`: activation before each picker initialization.
  Mart has one global Data/index and ignores later `data` props. The adapter retains
  the English baseline, replaces the additional vocabulary and clears changed
  compiled search strings and the index pool. Mart rebuilds them through its normal
  initialization. Previous languages never accumulate. Tests exercise RU → EN →
  JA → RU against the installed Mart engine; browser tests change the app setting.

The Russian source JSON occupies 967,433 bytes (91,651 bytes when gzipped);
only the active language is added to the live index. No dictionary is downloaded at runtime. English names, IDs, aliases, categories,
skins, image URLs and inserted Unicode values remain unchanged. Vocabulary matches
VS16 qualification aliases without shortening ZWJ/skin sequences. Keywords are
indexed in lowercase NFC/NFD forms and tokenized for multiword/hyphenated queries.
Additional spellings and transliterations require explicit dictionary aliases.

To add a language:

1. Add `src/locales/emoji-search/<locale>.json` with the shape below. Keys are original
   Unicode sequences. Record the pinned source, revision and license; review coverage
   and bundle full license/attribution texts. Search-only vocabulary is separate
   from visible UI translations in `resources.ts`.
2. Import it in `src/locales/emoji-search.ts` and register it in `emojiSearchLocales`.
   Its shape must satisfy `EmojiSearchLocale`. The app language activates the pack;
   missing vocabulary always falls back to English.
3. Add the reproducible import to `scripts/prepare-emoji-search.mjs` with pinned input
   SHA-256 checksums. `npm run emoji:prepare-search` is the only vocabulary command
   requiring network. Builds/tests use committed local resources. The Russian pack
   pins CLDR commit `a4b67247b446fd51b475991017a2481911210c60`; its exact source URLs
   and checksums are recorded in the generated JSON. The full upstream Unicode
   License v3 ships in the offline licenses settings alongside Noto notices.
4. Test native-language words, English fallback, regional tags, multiword queries,
   selected skins, language switching and offline behavior. Run build/verify and
   measure memory/startup for large packs.

```json
{
  "locale": "ru",
  "source": "<pinned source URL>",
  "revision": "<source revision>",
  "license": "<license identifier>",
  "keywords": { "🐱": ["кот", "кошка", "домашний кот"] }
}
```

## Resources and licenses

Pinned source: Google Noto Emoji `v2026-09-24-unicode18_0`, commit
`e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e`. The import includes official 2D SVGs
and the same repository's region-flag SVGs, optimized by pinned SVGO 4.1.0.
Original viewBoxes, colours and artwork are retained; no font or 3D artwork is
included. Every SVG has an explicit 128×128 intrinsic viewport, while its viewBox
preserves the artwork aspect ratio. This prevents WebKit from reusing an ambiguous
SVG intrinsic size after picker search updates. A browser regression compares actual
flag artwork bounds before search, after changing queries and after clearing them.
Flags use the upstream source art without the Noto font build's
wave/shadow transforms. An empty Illustrator-only placeholder in the American
Samoa SVG is removed while retaining the following group containing the flag.

`public/emoji/noto/provenance.json` records the revision, pinned Git trees,
source Git blob hashes, optimizer settings, final image SHA-256 checksums and
license sources/checksums. Each SVG carries an optimization notice; copyright
and license comments are preserved. The manifest currently has
5,235 qualified/unqualified sequences resolving to 3,955 distinct local images.
It includes regional, subdivision/tag, rainbow and other ZWJ flags.

Noto image resources use Apache 2.0; region-flags carry their own public-domain
notice and provenance. Unicode data use Unicode License v3. Full texts/notices
ship beside the images and are available offline in Settings → Updates →
Open-source licenses. No Noto font is distributed. Existing Lucide and Emoji Mart
licensing is unchanged.

## Updating

Run `npm run emoji:prepare` explicitly with Node 20.19+/22.12+ and
installed development dependencies (including pinned SVGO). Python is not needed.
Cached images are reused only when source blob, optimizer settings and output
checksum all match. Optional `AMBY_NOTO_SOURCE_CACHE` points to downloaded raw
SVGs; every cached source is verified against the pinned Git blob hash before use.
**Only this maintenance command needs the
network**; app startup, builds and verification never fetch emoji resources.

1. Choose an official stable release; change the pinned commit, 2D/third-party
   Git trees, Unicode version and input checksums in the script after reviewing
   their sources. Review changed license texts before accepting new checksums.
2. Run the importer. Source images must match their pinned Git blob hashes.
   The script reproduces the manifest, picker additions, license bundle and resource
   inventory. Remove obsolete images only after checking the new manifest.
3. Review the coverage report. Missing artwork remains a recorded null entry and
   displays the original native sequence; never replace it with a partial emoji.
4. Run resolver/component/callout tests, browser tests, `npm run build` and
   `npm run verify`. Resolver tests check the complete pinned manifest, image
   checksums and all picker skins.
5. Measure bundle size and repeat the platform/visual matrix below. Update this
   document and the changelog.

VS15 remains text presentation; VS16 and qualification aliases resolve through
the generated map without rewriting the input. Callouts preserve selectors,
skin modifiers, tags and unknown ZWJ tails as one value. Supported prefixes of
unknown sequences must not silently become a different icon. The parser uses
UTF-16 offsets and does not depend on `Intl.Segmenter` or OS Unicode versions.

## Verification matrix

Automated cases live in `emoji-resolver.test.ts`, `emoji-glyph.test.tsx`,
`callout-emoji.test.ts` and `tests/e2e/emoji-icons.spec.ts`. Existing icon tests
also cover the tree, database pages, Lucide and custom raster compatibility.

Before releasing, test native macOS/WKWebView, Windows/WebView2 and
Linux/WebKitGTK. Browser WebKit is not proof of all native platforms. Check
light/dark, normal/compact, 100/125/150/200% scaling and HiDPI; tree, tabs, titles,
properties, database views, archive/history, callouts and embedded note icons.
Check keyboard navigation, search, recents, all six skin choices, custom uploads,
Lucide colour selection and Unicode insertion. Block external requests with a
cold cache, then simulate a missing local image. Confirm no source text or JSON/
YAML value becomes an image path. Copying/editing normal text stays unchanged.

Compare cold launch, first picker opening, scrolling a 1,000-note tree, process
memory and raw/compressed build sizes against the same baseline. Native installer
size and WebView behaviour must be reported separately from browser measurements.

## Implementation measurements (2026-11-16)

These measurements cover the SVG stage before the CLDR search addition and
explicit intrinsic viewport adjustment.
Baseline: `dev` at `3d1d1633`; implementation: `codex/noto-emoji`. Three new
headless WebKit processes per build, 1280×800, synthetic 1,000-note tree with
three repeated compound/flag/skin icons. OS file caches were not flushed. Times
are medians; this small sample is indicative, not a release performance budget.
Both picker measurements wait for the final 40px search field styling; the
implementation also waits for the first decoded local image. Other development
checks were running on the machine, so small differences are inconclusive.
The first picker opening has about 279ms additional latency in this sample;
repeat on release hardware before accepting a latency budget or optimizing it.

| Measurement                                               |     Before |      After |
| --------------------------------------------------------- | ---------: | ---------: |
| Navigation until tree visible                             |     348 ms |     372 ms |
| First picker opening (after includes first decoded image) |     114 ms |     393 ms |
| 30 scroll/frame steps                                     |     509 ms |     490 ms |
| Browser process tree RSS before opening picker            | 123.75 MiB | 123.84 MiB |
| Frontend output, all files                                |   19.10 MB |   47.92 MB |
| Sum of individually gzipped frontend files                |    6.32 MB |   16.83 MB |

No new runtime dependency or font was added; SVGO is a maintenance-only development
dependency. The remaining overhead is metadata, picker additions and license/UI code.
The compressed figures are a transfer/storage comparison, **not installer sizes**.
A macOS debug `.app` was built successfully (134.38 MiB); no baseline installer
comparison, Windows installer or Linux package was available for this check.

The earlier PNG-stage full browser WebKit run passed 108 scenarios, including local rendering,
skin selection, Unicode save, unchanged ordinary text and broken-image fallback.
The final nine focused SVG scenarios also verify packaged-style CSP after asynchronous
initialization/search, equal search-field appearance, language switching with English
fallback, stable flag artwork proportions, cache handover and background focus preservation. Browser screenshots and a native macOS
smoke run supplement automated tests. A repeat native visual check of the final
SVG viewport and language-search changes could not finish because macOS was locked.
An already running installed Amby prevented a second dev instance from staying open;
closing that instance normally and launching the worktree requires an unlocked Mac.
Native Windows and Linux checks remain required before release. The complete theme/density/scaling matrix is a release
check, not established by these focused smoke scenarios.

## Format choice

The same 3,955 images were compared (including flags). Sizes below exclude
manifest/license overhead. SVG optimization uses SVGO 4.1.0 with multiple passes.

| Candidate                              |      Raw |     gzip | Brotli quality 5 |
| -------------------------------------- | -------: | -------: | ---------------: |
| Official source SVG                    | 46.28 MB | 19.80 MB |         19.15 MB |
| Optimized SVG, before per-file notices | 27.31 MB |  9.70 MB |          9.41 MB |
| Final SVG, including per-file notices  | 27.73 MB | 10.23 MB |                — |
| 72px PNG with prepared flags           | 12.02 MB | 12.11 MB |         12.04 MB |

SVG is selected for sharp scaling and smaller compressed distribution, despite
larger uncompressed sources. Tauri embeds assets with Brotli (quality 2 for debug,
9 for release in the currently locked codegen). No broad CSP or SVG-inline markup
permission was introduced: artwork is displayed through ordinary local `<img>`.
