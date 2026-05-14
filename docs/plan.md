# Plan: AI-Generated Photo Backfill Script

## Context

Per Jeff's [Studio on the Dashboard canvas](https://joylife.slack.com/docs/T032WG6NF/F0B373YQL6Q) and the [Studio on Joy Web Dashboard thread](https://joylife.slack.com/archives/C0AJ2970F4Y/p1778518042993309), Studio needs to be surfaced on the Joy dashboard for ~41k targeted US events. Aravind's piece (this script) is: for a given list of eventIds, fetch the event's main photo, generate a stylized cartoon via Gemini, and persist it to the event's photo gallery — so the dashboard hook (`useGeneratedEventPhoto()` that Anshul/Ilya are building) has artwork to surface.

This is a one-off backfill — Amy will share the eventId list. We talk to APIs only (no direct DB writes), and we follow the same shape/conventions as `card_service/script/fix-utm-reprints` (Bun + TypeScript + zod env validation + dry-run by default + per-row outcome log + text-file outputs).

## Approach

Working directory: `/Users/aravind/projects/joy/insert_ai_generated_photo_into_events/`.

For each eventId in the input file, the script will:

1. **Fetch the event's main photo URL** via the `eventById(id:)` GraphQL query (confirmed to exist), selecting `photo { id, url }`, `photoV2Url`, `firebasePhotoPath`, and `eventDesign.activeWebsiteHeaderPresentationLayout.dataJSON`. Apply the three-tier priority documented in the [Targeted Events canvas](https://joylife.slack.com/docs/T032WG6NF/F0B3W441HK2): header presentation layout `photos[0].url` → `photoV2Url` → `firebasePhotoPath` (use this field directly instead of the older `hasFirebasePhoto` boolean). Use the extraction logic in `joy-web/src/shared/utils/eventPhoto/useEventPhoto.ts:46-65` as the reference for shape and ordering.
2. **Skip if already processed** (idempotency): list the event's gallery media and skip if a photo whose Filestack assetId / filename is `joy-studio-generated-{eventId}.png` already exists. Uses the deterministic filename from step 4 as the idempotency key.
3. **Generate stylized image** by porting `studio/src/lib/generateStylizedImage.ts` into a standalone module. Strip SvelteKit-specific bits (`$app/server`, `$env/static/private`, `getRequestEvent`, `logToSlack`); read `GOOGLE_SERVICE_ACCOUNT_JSON` from `process.env`. Default `styleId = 'martoon'` (the only style currently used in production — see `studio/src/routes/[[draftId]]/page.remote.ts:39`). Returns a `Buffer`.
4. **Upload Buffer → Filestack** to match how joy-web mutations expect inputs (assetId + Filestack CDN url). The joy-web client picker (Filestack) only runs in-browser, but the *credentials* it uses are server-signed and exposed via the GraphQL `Filestack` query at `joy-web/src/graphql/queries/filestack.ts`. The script will:
   - Call the `Filestack` query to fetch `{ apiKey, policy, signature }`.
   - Use `filestack-js` (Node-compatible) to upload the Buffer with a deterministic `name: joy-studio-generated-{eventId}.png` so re-runs are detectable.
   - Capture the response's `url` + `handle`; use the filename as `assetId` (matches client convention at `joy-web/src/shared/components/PhotoUploader/hooks/usePhotoUpload.tsx:156-169`).
5. **Add to the event's photo gallery** using the modern path:
   - `uploadMediaFromUrls` mutation (`joy-web/src/apps/guest/routes/MediaCollection/MediaCollectionMutations.graphql:37-56`) with `{ eventId, photos: [{ assetId, handle, url }] }`. Omitting `collectionId` lands it in the default "All Photos" collection per `usePhotoUpload.tsx:72,117`.
6. **Record outcome** (ok / skipped / errored) and write to text files mirroring fix-utm-reprints (`results.txt`, `errored.txt`, `skipped.txt`).

Dry-run by default; require explicit `--commit` to upload + mutate.

## Files to create

- `package.json` — Bun, deps: `axios`, `zod`, `debug`, `@google/genai` (^1.44.0 per studio), `filestack-js`.
- `tsconfig.json` — copy from fix-utm-reprints.
- `index.ts` — CLI + main loop (mirror fix-utm-reprints structure: `parseArgs`, `processEvent`, `main`, outcome summary).
- `lib/generateStylizedImage.ts` — port of the studio function, sans SvelteKit deps.
- `lib/joyWebClient.ts` — thin axios GraphQL wrapper (bearer auth) with operations: `getEventPhoto`, `getFilestackCredentials`, `uploadMediaFromUrls`, and a "list event media" query for the idempotency check.
- `lib/filestackUpload.ts` — uploads Buffer via `filestack-js` using server-signed creds.
- `README.md` — env vars, run instructions, verification steps, modelled on fix-utm-reprints' README.
- `events.txt.example` — sample input (one eventId per line; `#` comments allowed).

## CLI

```
bun run index.ts --file ./events.txt              # dry-run
bun run index.ts --file ./events.txt --commit     # actually upload + mutate
bun run index.ts --file ./events.txt --delay-ms 3000 --commit
```

Flags (subset of fix-utm-reprints'): `--file`, `--event-ids` (comma list), `--commit`, `--delay-ms` (default 2000 to be polite to Gemini + joy-web; applied before processing each eventId), `--style-id` (default `martoon`), `--results-output`, `--errored-output`.

## Env vars (all required, validated via zod at startup)

| Var | Notes |
|---|---|
| `JOY_WEB_GRAPHQL_URL` | e.g. `https://api.withjoy.com/graphql` or dev equivalent |
| `JOY_WEB_AUTH_TOKEN` | Operator bearer token (same "impersonate yourself" pattern as fix-utm-reprints) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service account JSON for Vertex AI / Gemini (same as studio) |

No Filestack key in env — it's fetched per-run from the joy-web `Filestack` query (server-signed policy/signature).

## Outcome types

Mirror fix-utm-reprints' shape:
- `ok`: `{ eventId, sourcePhotoUrl, filestackUrl, mediaPhotoId }`
- `skipped`: `{ eventId, reason }` — reasons: `no_source_photo`, `already_generated`
- `errored`: `{ eventId, reason }` — reasons: `fetch_event_failed`, `gemini_failed:IMAGE_PROHIBITED_CONTENT`, `gemini_failed:UNKNOWN`, `filestack_upload_failed`, `upload_media_failed`

## Notes / follow-ups (not blocking)

- **Rate limits / batch size.** 41k events at default delay (2s) = ~23h serial. Gemini's quota and joy-web's tolerance are unknown. Start with a small (~50 event) commit run, measure end-to-end timing per event, then tune `--delay-ms` and decide whether to parallelize.
- **Tagging fallback.** If Anshul lands a proper "generated" tagging mechanism later, swap the filename-based idempotency check for the tag-based one; the rest of the script is unaffected.

## Verification

End-to-end manual run against dev:

1. Pick 2-3 dev eventIds with header photos. Put them in `events.txt`.
2. `bun run index.ts --file events.txt` — confirm dry-run logs show source photo URL + would-be filename, no mutations.
3. `bun run index.ts --file events.txt --commit` — confirm:
   - Gemini returns a buffer (check stdout for timing line).
   - Filestack upload returns a CDN URL (eyeball it in browser).
   - `uploadMediaFromUrls` returns a `MediaUploadCollection` with at least one upload entry whose `photo.url` is reachable.
4. In the joy web admin for the event, open the photo gallery / "All Photos" album and confirm the generated artwork appears.
5. Re-run the same `--commit` and confirm each eventId now reports `skipped: already_generated` (idempotency check).
6. Inspect `results.txt` / `errored.txt` for shape parity with fix-utm-reprints outputs.
