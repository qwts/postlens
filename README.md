# PostLens

A small Manifest V3 Chrome/Brave extension that adds **JEV Analyze** to X posts. Each click sends the post's visible text and reliably available metadata to Jev and displays all eight analysis dimensions inline. An optional OpenAI key and timeline goal add context and suggested actions. There are no runtime dependencies or build steps.

## Install

1. Download and unzip a release, or clone this repository.
2. Open `chrome://extensions` (Brave: `brave://extensions`).
3. Enable **Developer Mode**.
4. Choose **Load unpacked** and select the folder containing `manifest.json`.
5. Open the extension's **Options** (Details → Extension options, or click its toolbar icon).
6. Enter a Jev API key from the [TypeSafe dashboard](https://console.typesafe.ai) and click **Save key**.
7. Open or refresh `https://x.com`, then click **JEV Analyze** on an individual post.

Chrome/Brave based on Chromium 109 or newer is required. Reload the extension and refresh existing X tabs after changing its source. API calls can incur charges on your TypeSafe account. Saving a key does not make a test API call.

## Verified Jev contract

Verified against the official [API reference](https://docs.typesafe.ai/api) and [quickstart](https://docs.typesafe.ai/introduction/quickstart) on September 17, 2026, before implementation:

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

The request is exactly `{ "state": <object>, "model": "jev-latest", "questions": <map> }`. `questions.js` holds the supplied eight-question object unchanged; every original post-analysis request includes it. Optional timeline guidance uses a separate two-question request from `guidance.js`. Each question uses `type`, `instructions`, and `criteria`.

The response envelope is `{ "model": <string>, "answers": <map>, "usage": { "input_tokens": <integer>, "output_tokens": <integer> }`. Answers are keyed by question ID:

- Noul: `{ "type": "noul", "noul": <number 0..1> }`.
- Choice: `{ "type": "choice", "choice": <option key>, "probabilities": { <option>: <number>, ... }, "confidence": <number 0..1> }`.
- Score: `{ "type": "score", "score": <weighted level index>, "legend": { "0": <description>, ... }, "probabilities": { "0": <number>, ... }, "confidence": <number 0..1> }`.

V1 renders Noul as a percentage and the five-level scores as `0–4`. It shows score confidence when supplied. The worker validates required answer values and returns only the typed display fields; it does not forward raw API responses to X. The API reference lists score probabilities, though the quickstart's score example omits them. The renderer does not depend on probabilities or legends.

### Endpoint/base URL

`JEV_ENDPOINT` at the top of `background.js` is the **full request URL**, including `/v1/systemone`; `JEV_MODEL` is next to it. These are source constants, not page-controlled settings. If you intentionally change the API host, also update `host_permissions` in `manifest.json` and reload the extension. Never point an endpoint receiving your Bearer key at an untrusted service. No proxy is implemented in V1; calls originate in the service worker with explicit API host permission.

## Behavior and limitations

- Detects `article[data-testid="tweet"]`, observes SPA mutations, and replaces its controls when X reuses an article for different text or a different status ID. Late responses cannot attach to a different post.
- Extracts visible post text (including text emoji alt labels), name, handle, visible verified badge when present, timestamp permalink ID, timestamp, and displayed views when available. Missing data is omitted. View counts remain display strings such as `1.2K`; no precision is invented.
- Quoted-post containers are excluded from the outer post's text and identity. Images, video, quoted content, linked pages, profiles, hidden text, and inaccessible/truncated text are not fetched or analyzed. Image-only posts have a disabled control. Expand long posts on X before analyzing them.
- The content script makes cache-only lookups on mount. Only trusted clicks on Analyze/Retry can initiate API calls. There is no automatic analysis or automatic API retry.
- Concurrent requests for the same post share one call. Results use a versioned status-ID key in `chrome.storage.local`; when no ID is available, a SHA-256 hash of author and text is used. Cache reads work without a key. The latest 500 saved entries (post scores and goal advice combined) persist across restarts; oldest entries are evicted. Edited posts with the same ID retain their cached result until the cache is cleared. Bump `CACHE_VERSION` after question/model changes.
- A 25-second timeout bounds a call. Network, authentication, invalid-response, and HTTP errors appear beside a Retry control. Rate-limit/overload responses enforce at least a one-minute cooldown and honor longer `Retry-After` values. If saving a result fails, the UI explicitly warns that it was not cached.
- Use Options to remove either key, change/disable goal advice, or clear saved results. Clearing results does not remove keys or your goal. Refresh X after changing settings. Stop running analyses before clearing, then refresh X to remove already-rendered results.

“Factual claim” means the probability that a checkable claim exists, **not** the probability the claim is true. Evidence alignment only considers the supplied visible state; V1 performs no external fact-checking. Automation signals do not prove that an account is a bot. Account context uses sparse metadata and a technology-account rubric, so it is limited outside that context. Confidence is Jev's reported confidence, not independent verification.

X's DOM can change. Browser tests use representative X markup, not a live signed-in X session; selectors may need maintenance.

## Optional timeline goal advice

1. In Options, save an OpenAI API key and enter a concrete timeline goal, for example: “Learn practical hardware engineering, find original benchmarks and thoughtful criticism, avoid promotional giveaways.”
2. Enable **Add goal advice when I analyze a post**, save, and refresh X. Both Jev and OpenAI keys are required for new advice. Saving keys alone does not enable advice or call an API.
3. Click **JEV Analyze**. Previously analyzed posts show **Analyze for my goal** when their original scores are cached but goal advice is not.

The pipeline deliberately separates judgments:

- Jev runs the original eight questions against the visible post alone. These scores do not change to match a user's interests.
- **GPT-5.6 Luna** returns a short structured interpretation: summary, topics, relationship to the goal, potential value/downside, and missing context. It reads the visible post only; no web search, profile scraping, image analysis, or independent verification occurs.
- Jev receives that explicitly labeled, unverified interpretation alongside the original post, goal, and original scores. A separate question pair returns goal alignment (0–4) and a suggested action: Skip, Like, Like + follow, Consider mute, or Review.

The UI explains the suggestion and links to the author's X profile for review. All likes, follows, and mutes are performed by the user with X's native controls. The extension never clicks those controls. Account-level decisions need more context than a single post; personal disagreement and an automation score are not sufficient reasons to mute. No improvement in X ranking is guaranteed.

Low action confidence (below 0.65), or a like/follow suggestion with goal fit below 3 or fit confidence below 0.65, is presented as **Review**. These are conservative product heuristics, not calibrated probabilities of improving a timeline. Generated interpretation is not supplied to the original evidence-alignment question and is not promoted to factual evidence.

Advice is cached separately using post identity, visible text/author, a hash of the goal, model, and guidance version. Changing the goal causes new advice to be requested only on a click and reuses the original post scores. Original scores stay available if OpenAI or the guidance request fails. **Retry timeline advice** retries the optional flow; successful base analysis is not repeated. Disabling advice stops new OpenAI calls after any already-running requests finish. Refresh X after changing settings to remove old suggestions. Removing a key does not delete cached results; use Clear saved analyses to delete them.

An uncached goal-enabled analysis uses one original Jev call, one OpenAI call, and one guidance Jev call. Cached original scores save the first call; fully cached results require no API calls. Each call has a 25-second timeout, with explicit user retries and separate provider rate-limit cooldowns. Guidance failures are not cached, so a retry can incur a new OpenAI call. Saved goal variants share the 500-entry local cache limit.

### OpenAI model and contract

Chosen from the official [GPT-5.6 Luna model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-luna): it is designed for cost-sensitive workloads and supports structured outputs. This bounded interpretation task does not need a large reasoning model. `guidance.js` uses `gpt-5.6-luna` with low reasoning effort and an output limit; actual latency/quality still need evaluation with your posts. Model access depends on the API account.

The worker calls `POST https://api.openai.com/v1/responses` with `Authorization: Bearer <OPENAI_KEY>` and JSON containing `model`, `instructions`, string `input`, `reasoning`, `max_output_tokens`, `store: false`, and `text.format: { type: "json_schema", name, strict: true, schema }`. See the official [text generation](https://developers.openai.com/api/docs/guides/text) and [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) guides, checked September 17, 2026. It parses assistant `output_text` content across the response's `output` array, rejects refusals/incomplete output, validates bounded fields, and never exposes raw API errors. No tools are enabled. `store: false` disables response storage for API retrieval; it is not a promise about all provider data retention.

`OPENAI_ENDPOINT`, `OPENAI_MODEL`, schemas, and `GUIDANCE_VERSION` live in `guidance.js`. The `api.openai.com` host permission is required even though the feature is optional. Reload the extension after updating from the first alpha; the browser may request the additional host permission. Existing Jev keys and base caches are retained.

## Security and privacy

The Options page accepts each key and passes it directly to the service worker. Only the service worker reads/stores the saved keys and uses them for API authentication. The Options page receives only booleans indicating whether keys exist, plus the non-secret timeline settings; it clears key inputs after saving.

The worker calls `chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })` before any credential access. Content scripts cannot read that storage area. Messages are checked against the extension ID, sender URL, frame, and message type; only the Options page can save/remove keys, change the timeline goal, or clear the cache. Keys are never injected into page context, DOM attributes, content-script globals, logs, or responses. Requests reject redirects, omit cookies, and use a fixed endpoint. Results use text DOM APIs, never API-supplied HTML. There are no externally connectable messages or web-accessible extension resources.

**`chrome.storage.local` is not a secure credential vault.** It is acceptable for this personal prototype, but local software, browser profile access, and extension developer tools can expose it. This extension sends the selected post's text and extracted metadata to TypeSafe, including content visible in a private/protected feed. Base analyses contain typed results and timestamps; tweet IDs remain in cache keys. When goal advice is enabled, the goal and visible post are also sent to OpenAI, and Jev receives the goal and generated interpretation in a separate request. Goals and generated context are stored locally; generated context can quote or paraphrase post text. Results rendered inside X, including goal-related explanations, can be read by the X page.

For distribution, move provider keys server-side: **extension → Cloudflare Worker → Jev/OpenAI**. Store keys as Worker secrets and keep the extension keyless. Add user authentication, rate limiting, and abuse controls to that proxy before sharing it. V1 does not implement a Worker.

## Development and release

```sh
npm ci
npx playwright install chromium
npm run check
npm test
npm run test:browser
npm run package
```

Node 22+ and Python 3 are needed for development/packaging. Playwright is development-only. Unit tests exercise request/auth handling, storage restrictions, cache behavior, validation, and retries. Browser tests load the actual MV3 extension into Chromium, exercising Options, isolated content scripts, Chrome messaging/storage, extraction, inline output, SPA reuse, goal advice, and errors with mocked Jev and OpenAI responses. They spend no API credits. Real API keys and a signed-in X session are still needed for live acceptance testing.

Packaging writes `dist/postlens-0.2.0-alpha.1.zip` plus its SHA-256 checksum. The ZIP uses an explicit runtime-file allowlist, excludes development files and credentials, and has stable file timestamps. Unzip before using Load unpacked.

GitHub Actions runs validation and browser tests on `main` pushes, pull requests, and manual dispatch, then uploads an installable ZIP/checksum artifact. Pushing a `v*` tag also creates a GitHub release with those assets **only after checks pass**. Tags match `manifest.json`'s `version_name` when present (for example `v0.2.0-alpha.1`), otherwise its numeric `version`. Chrome's numeric version stays aligned with `package.json`. Alpha/beta/rc tags are marked as GitHub pre-releases; an existing release is preserved. No provider secrets are required in CI. This creates GitHub releases; Chrome Web Store publication is separate.

The repository origin is `https://github.com/qwts/postlens.git`. Use the configured `qwts-codex-agent` / `agent-bot` identity for GitHub authentication and signed commits.

## TODO

- [ ] Image/vision support with explicit image transmission controls and a compatible model.
- [ ] Profile-page metadata enrichment with provenance and missing-data handling.
- [ ] Optional hover analysis with consent, debouncing, and spend limits.
- [ ] Cloudflare Worker proxy with secret storage, authentication, and abuse protection.
- [ ] Per-domain adapters beyond X.
- [ ] Configurable question sets with cache invalidation/versioning.
- [ ] Export/history with deletion controls and retention settings.

- [ ] Optional source-backed web research with clickable citations and explicit cost controls.
