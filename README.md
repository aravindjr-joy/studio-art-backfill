# studio-art-backfill

One-off backfill script: given a list of eventIds, fetch each event's main
photo, generate a stylized cartoon via Gemini (Vertex AI), upload to Filestack,
and add it to the event's photo gallery via joy-web GraphQL.

Plan: [docs/plan.md](docs/plan.md).
Investigation notes for past fixes: [docs/attempted-fixes.md](docs/attempted-fixes.md).

The Filestack `assetId` looks like `studio-gouache-{Date.now()}.png`. Each run
uses a fresh timestamp, but the idempotency check matches by prefix: if any
existing photo in the event's gallery has an assetId starting with
`studio-gouache-`, the event is reported `skipped: already_generated` and no
new image is generated.

Pass `--force` to override this — any existing photo whose `assetId` starts
with `studio-gouache-` is deleted via the `deleteMedia` mutation first, then
a fresh image is generated and uploaded.

## Install

```sh
cd insert_ai_generated_photo_into_events
bun install
```

## Env

| Var                          | Notes                                                                         |
|------------------------------|-------------------------------------------------------------------------------|
| `JOY_WEB_GRAPHQL_URL`        | joy-web GraphQL endpoint (e.g. `https://api-dev.withjoy.com/graphql`).        |
| `JOY_WEB_ID_TOKEN`           | Operator's ID token. Get it by logging in to `withjoy.com` and copying the value from `https://withjoy.com/authinfo`. The script exchanges it for a userJWT at startup via the `authenticateUser` query and uses that JWT as the bearer for all GraphQL calls. |
| `GOOGLE_SERVICE_ACCOUNT_JSON`| Service account JSON for Vertex AI / Gemini (same as studio).                 |

Filestack credentials are NOT in env — they are fetched per-run from joy-web's
`Filestack` GraphQL query (server-signed policy/signature).

## Run

Dry-run (default — fetches event, prints what would happen, no Gemini or
upload calls):

```sh
bun run index.ts --event-ids EVENT_A,EVENT_B
bun run index.ts --file ./events.txt
```

Commit:

```sh
bun run index.ts --file ./events.txt --commit
bun run index.ts --file ./events.txt --commit --save-images-to ./gen-images
```

`events.txt` is one eventId per line; `#` lines are ignored. See
[events.txt.example](events.txt.example).

### Flags

| Flag                | Default          | Notes                                                       |
|---------------------|------------------|-------------------------------------------------------------|
| `--file PATH`       | —                | Path to a newline-delimited eventIds file.                  |
| `--event-ids LIST`  | —                | Comma-separated eventIds (alternative to `--file`).         |
| `--commit`          | dry-run          | Actually generate, upload, and save.                        |
| `--force`           | off              | Delete any existing photo whose `assetId` starts with `studio-gouache-` before generating a new one. Combine with `--commit` to actually delete; in dry-run mode it just logs which mediaId/url would be deleted. |
| `--delay-ms N`      | 2000             | Delay applied *before* processing each event. With `--concurrency > 1`, applied per worker (so effective inter-event spacing is roughly `delayMs / concurrency`). |
| `--concurrency N`   | 1                | Process N events in parallel. With `N > 1`, each event's terminal output is buffered and flushed as one block when that event completes, so banners stay contiguous. Start at 3-5 against a fresh Gemini quota; higher values surface rate-limit errors faster. |
| `--style-id ID`     | `martoon`        | Gemini style (`martoon`, `toon`, `doodle`).                 |
| `--results-output`  | `./results.txt`  | Output path for ok rows.                                    |
| `--errored-output`  | `./errored.txt`  | Output path for errored rows.                               |
| `--skipped-output`  | `./skipped.txt`  | Output path for skipped rows.                               |
| `--save-images-to DIR` | —             | If set, writes each generated PNG to `DIR/{eventId}/{filename}`. Useful for eyeballing output without checking the gallery. Directories are created if missing. |

## Deleting generated photos

Use `delete-generated-photos.ts` to remove `studio-gouache-*` photos from
specific events without re-generating them (unlike `--force` in the main
script, which deletes and immediately regenerates).

```sh
# Dry-run (default — shows what would be deleted)
bun run delete-generated-photos.ts --file ./events-to-delete.txt
bun run delete-generated-photos.ts --event-urls "https://withjoy.com/angela-and-daniel-sep-26/edit,https://withjoy.com/foo-and-bar/edit"

# Actually delete
bun run delete-generated-photos.ts --file ./events-to-delete.txt --commit
```

Input file is one event URL per line; `#` lines are ignored. URLs can be full
(`https://withjoy.com/{handle}/edit`) or bare handles (`angela-and-daniel-sep-26`).
See [events-to-delete.txt.example](events-to-delete.txt.example).

| Flag               | Default | Notes                                              |
|--------------------|---------|----------------------------------------------------|
| `--file PATH`      | —       | Path to a newline-delimited event-URLs file.       |
| `--event-urls LIST`| —       | Comma-separated event URLs (alternative to `--file`). |
| `--commit`         | dry-run | Actually call `deleteMedia` for each match.        |

Terminal output:

```
────────── angela-and-daniel-sep-26 ──────────
  would delete: mediaId=abc123  url=https://withjoy.com/media/.../studio-gouache-...

Summary: 2 processed, 0 deleted (1 would delete), 0 errored
```

Exits non-zero if any event errored.

## Source photo selection

For each event, the script picks a source photo by trying these tiers in
order, and falling through if a tier's URL is missing or filtered:

1. `eventDesign.activeWebsiteHeaderPresentationLayout.dataJSON.photos[0].url`
   — origin `headerLayout`.
2. `event.photoV2.url` — origin `photoV2Url`. Skipped if
   `event.photoV2.__typename === 'DefaultPagePhoto'`.
3. `event.firebasePhotoPath` — origin `firebasePhotoPath`. Used directly when
   it's already an absolute URL, otherwise resolved to
   `https://withjoy.com/media/{eventId}/{firebasePhotoPath}`.

Any candidate URL that starts with one of these default-asset prefixes is
filtered out and the script falls through to the next tier:

- `https://withjoy.com/assets/public/wedding-website/designs-gallery/default-assets/`
- `https://withjoy.com/assets/public/marcom-prod/wedding-website-gallery/gallery_thumbnails/default_preview_images/`
- `https://withjoy.com/assets/public/defaultwebsitephotos/`

A candidate URL is also filtered out if its query string contains
`isDefault=true` (e.g. `?isDefault=true` or `&...&isDefault=true`).

A candidate URL is also filtered out if its filename (the last segment of
the URL path) matches a known stock-photo filename pattern. Currently:
`classic_wedding_*` and `-unsplash` (case-insensitive). Patterns live in
`STOCK_PHOTO_FILENAME_PATTERNS` at the bottom of `lib/joyWebClient.ts` —
add new regexes there as more stock-photo families turn up.

If every tier is empty or filtered, the event is reported
`skipped: no_source_photo`.

## Image generation and margin

The chosen source photo is sent to Gemini (Vertex AI, model
`gemini-3.1-flash-image-preview`) at 3:4 aspect ratio with instructions to
fill the frame edge-to-edge. The returned PNG is then post-processed with
`sharp`: a proportional white border of `width * 0.1` is added on each
horizontal side and `height * 0.1` on each vertical side, so the final
image keeps the 3:4 aspect ratio with a generous, uniform margin around the
artwork. Tune `MARGIN_FRACTION` at the top of
`lib/generateStylizedImage.ts` to adjust the border.

## Console output

Each event is processed under its own banner, with a blank line above for
visual separation:

```
────────── [3/5] e878153e-abb4-56d3-87ac-92b1bb5dece8 ──────────
e878153e-...  handle=geralt-and-yennifer  source-origin=headerLayout  source-url=https://...
e878153e-...  handle=geralt-and-yennifer  saved-to-disk=gen-images/e878153e-.../studio-gouache-1747234567890.png
e878153e-...  handle=geralt-and-yennifer  ok       source-origin=headerLayout  filestack=https://cdn.filestackcontent.com/...  mediaPhotoId=ad6bf...  mediaUrl=https://dev.withjoy.com/media/...
```

At the end of the run a one-line summary is printed (`Total / ok / skipped /
errored`).

With `--concurrency > 1`, each event's lines are buffered and flushed as one
contiguous block when that event completes — so banners and their key/value
pairs never interleave between workers, but the terminal order reflects
completion order rather than input order. The input position is still shown
in each banner's `[i/N]` index, and the run-summary `.txt` and `.html` keep
events in input order regardless.

## Output files

All four output sinks include the event's website handle (or `-` if missing)
so you can correlate rows back to a specific event quickly.

`results.txt` — one tab-separated row per ok event (overwritten each run):

```
eventId   eventHandle   sourcePhotoOrigin   sourcePhotoUrl   filestackUrl   mediaPhotoId   mediaUrl
```

`skipped.txt` — overwritten each run:

```
eventId   eventHandle   reason
```

`errored.txt` — overwritten each run:

```
eventId   eventHandle   sourcePhotoOrigin   sourcePhotoUrl   reason
```

`run-summaries/{ISO-timestamp}.txt` — *appended* across runs (one new file
per invocation). Contains the run's started/completed timestamps, duration,
mode (dry-run vs commit), style, delay, totals, and a per-event listing
under OK / SKIPPED / ERRORED sections. Useful for keeping a history when the
per-run `.txt` files get overwritten.

`run-summaries/{ISO-timestamp}.html` — HTML report generated alongside the `.txt`
file. Provides a formatted view of the run with sections for OK / SKIPPED / ERRORED
events, including event details and inline logs. Open in a browser for easier review.

## Outcome reasons

- `skipped`: `event_not_found`, `not_a_wedding_event`, `no_source_photo`, `already_generated`
- `errored`: `fetch_event_failed`, `fetch_event_media_failed`,
  `gemini_failed:<finishReason>`, `filestack_credentials_failed`,
  `filestack_upload_failed`, `upload_media_failed`, `rehost_poll_failed`,
  `rehost_failed`, `rehost_not_completed`, `force_delete_failed`

The three `rehost_*` reasons surface failures of the async media-service
rehost step: `uploadMediaFromUrls` is asynchronous and we poll
`uploadMediaStatus` until it reports COMPLETED (or a per-upload FAILED).

## Verification

After a `--commit` run against dev:

1. Check `results.txt` — every row has a non-empty `filestackUrl`,
   `mediaPhotoId`, and `mediaUrl`. The `mediaUrl` should return HTTP 200
   for a `curl -sI` probe (and serve the rendered image in a browser).
2. Open the joy web admin for one of the events → photo gallery / "All
   Photos" → confirm the generated artwork appears.
3. Re-run the same command with `--commit`. Each eventId should now report
   `skipped: already_generated`.
4. Inspect the latest file under `run-summaries/` for a full per-event
   recap of the run.

## References

- Stylized-image generation ported from
  `joy/studio/src/lib/generateStylizedImage.ts`.
- Photo extraction priority and field shape mirror
  `joy/joy-web/src/shared/utils/eventPhoto/useEventPhoto.ts`.
- `uploadMediaFromUrls` mutation and async status polling mirror
  `joy/joy-web/src/apps/guest/routes/MediaCollection/MediaCollectionMutations.graphql`
  and `joy/joy-web/src/shared/hooks/usePhotoUploadPolling/usePhotoUploadPolling.tsx`.
- CLI / outcome shape modelled on
  `joy/card_service/script/fix-utm-reprints/index.ts`.
