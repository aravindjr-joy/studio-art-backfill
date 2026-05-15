import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import createDebugger from 'debug';
import z from 'zod';

import {
  GenerateStylizedImageError,
  generateStylizedImage,
  type StyleID,
} from './lib/generateStylizedImage.ts';
import {
  extractSourcePhotoUrl,
  JoyWebClient,
  exchangeIdTokenForUserJwt,
  type PhotoInput,
  type PhotoSource,
  type UploadMediaResponse,
} from './lib/joyWebClient.ts';
import { uploadBufferToFilestack } from './lib/filestackUpload.ts';
import { buildRunHtmlReport, type EventReportRecord, type RunHeader } from './lib/runReport.ts';

const debug = createDebugger('insert-generated-photo:app');

const JOY_WEB_GRAPHQL_URL = z
  .string({ message: 'JOY_WEB_GRAPHQL_URL is required' })
  .url()
  .parse(Bun.env.JOY_WEB_GRAPHQL_URL);

const JOY_WEB_ID_TOKEN = z
  .string({ message: 'JOY_WEB_ID_TOKEN is required' })
  .parse(Bun.env.JOY_WEB_ID_TOKEN);

z.string({ message: 'GOOGLE_SERVICE_ACCOUNT_JSON is required' }).parse(
  Bun.env.GOOGLE_SERVICE_ACCOUNT_JSON,
);

const DEFAULT_DELAY_MS = 2000;
const DEFAULT_RESULTS_OUTPUT = './results.txt';
const DEFAULT_ERRORED_OUTPUT = './errored.txt';
const DEFAULT_SKIPPED_OUTPUT = './skipped.txt';
const RUN_SUMMARIES_DIR = './run-summaries';
const DEFAULT_STYLE_ID: StyleID = 'martoon';

const VALID_STYLES: ReadonlyArray<StyleID> = ['martoon', 'toon', 'doodle'];

const DEFAULT_CONCURRENCY = 1;

type CliArgs = {
  eventIds: string[];
  commit: boolean;
  force: boolean;
  delayMs: number;
  concurrency: number;
  styleId: StyleID;
  resultsOutput: string;
  erroredOutput: string;
  skippedOutput: string;
  saveImagesTo: string | null;
};

function parseArgs(): CliArgs {
  const argv = Bun.argv.slice(2);
  let eventIds: string[] = [];
  let commit = false;
  let force = false;
  let delayMs = DEFAULT_DELAY_MS;
  let concurrency = DEFAULT_CONCURRENCY;
  let styleId: StyleID = DEFAULT_STYLE_ID;
  let resultsOutput = DEFAULT_RESULTS_OUTPUT;
  let erroredOutput = DEFAULT_ERRORED_OUTPUT;
  let skippedOutput = DEFAULT_SKIPPED_OUTPUT;
  let saveImagesTo: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--commit') {
      commit = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--event-ids') {
      const value = argv[++i];
      if (!value) throw new Error('--event-ids requires a value');
      eventIds = value.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--file') {
      const path = argv[++i];
      if (!path) throw new Error('--file requires a path');
      eventIds = readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('#'));
    } else if (arg === '--delay-ms') {
      const value = argv[++i];
      if (!value) throw new Error('--delay-ms requires a value');
      delayMs = Number(value);
      if (!Number.isFinite(delayMs) || delayMs < 0) {
        throw new Error(`--delay-ms must be a non-negative number, got: ${value}`);
      }
    } else if (arg === '--concurrency') {
      const value = argv[++i];
      if (!value) throw new Error('--concurrency requires a value');
      concurrency = Number(value);
      if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error(`--concurrency must be a positive integer, got: ${value}`);
      }
    } else if (arg === '--style-id') {
      const value = argv[++i];
      if (!value) throw new Error('--style-id requires a value');
      if (!VALID_STYLES.includes(value as StyleID)) {
        throw new Error(`--style-id must be one of ${VALID_STYLES.join(', ')}, got: ${value}`);
      }
      styleId = value as StyleID;
    } else if (arg === '--results-output') {
      const value = argv[++i];
      if (!value) throw new Error('--results-output requires a path');
      resultsOutput = value;
    } else if (arg === '--errored-output') {
      const value = argv[++i];
      if (!value) throw new Error('--errored-output requires a path');
      erroredOutput = value;
    } else if (arg === '--skipped-output') {
      const value = argv[++i];
      if (!value) throw new Error('--skipped-output requires a path');
      skippedOutput = value;
    } else if (arg === '--save-images-to') {
      const value = argv[++i];
      if (!value) throw new Error('--save-images-to requires a directory path');
      saveImagesTo = value;
    } else {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }

  if (eventIds.length === 0) {
    throw new Error('No eventIds provided. Pass --event-ids A,B,C or --file path');
  }

  return {
    eventIds,
    commit,
    force,
    delayMs,
    concurrency,
    styleId,
    resultsOutput,
    erroredOutput,
    skippedOutput,
    saveImagesTo,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function formatHumanFilenameTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hours24 = date.getHours();
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const meridiem = hours24 < 12 ? 'AM' : 'PM';
  return `${yyyy}-${mm}-${dd}_${pad(hours12)}-${pad(date.getMinutes())}-${meridiem}`;
}

class EventLogger {
  readonly lines: string[] = [];
  constructor(private stream: boolean) {}
  line(s: string): void {
    this.lines.push(s);
    if (this.stream) console.log(s);
  }
  kv(key: string, value: string | number | null | undefined): void {
    this.line(`  ${key}: ${value ?? '-'}`);
  }
  flushToConsole(): void {
    if (this.stream) return;
    for (const l of this.lines) console.log(l);
  }
}

function logOutcomeResult(outcome: Outcome, logger: EventLogger): void {
  if (outcome.status === 'ok') {
    const isDryRun = outcome.filestackUrl === '(dry-run)';
    if (!isDryRun) {
      logger.kv('filestack-url', outcome.filestackUrl);
      logger.kv('media-photo-id', outcome.mediaPhotoId);
      logger.kv('media-url', outcome.mediaUrl);
    }
    logger.kv('status', isDryRun ? 'ok (dry-run)' : 'ok');
  } else {
    logger.kv('status', outcome.status);
    logger.kv('reason', outcome.reason);
  }
}

const POLL_INITIAL_INTERVAL_MS = 1000;
const POLL_MAX_INTERVAL_MS = 10_000;
const POLL_BACKOFF = 1.2;
const POLL_MAX_ATTEMPTS = 60;
const POLL_MAX_ERRORS = 5;

async function pollUntilComplete(
  client: JoyWebClient,
  eventId: string,
  uploadId: string,
): Promise<UploadMediaResponse> {
  let interval = POLL_INITIAL_INTERVAL_MS;
  let errors = 0;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(interval);
    try {
      const status = await client.uploadMediaStatus(eventId, uploadId);
      if (status.status === 'COMPLETED') return status;
      errors = 0;
    } catch (err) {
      errors++;
      debug('%s poll error (%d/%d): %s', eventId, errors, POLL_MAX_ERRORS, (err as Error).message);
      if (errors >= POLL_MAX_ERRORS) {
        throw new Error(`uploadMediaStatus failed ${errors} times: ${(err as Error).message}`);
      }
    }
    interval = Math.min(interval * POLL_BACKOFF, POLL_MAX_INTERVAL_MS);
  }
  throw new Error(`polling timed out after ${POLL_MAX_ATTEMPTS} attempts`);
}

const GENERATED_FILENAME_PREFIX = 'studio-gouache-';

function generatedFilenameSuffix(_eventId: string): string {
  return `${GENERATED_FILENAME_PREFIX}${Date.now()}.png`;
}

type Outcome =
  | {
      eventId: string;
      eventHandle: string | null;
      ownerFirstName?: string | null;
      fianceeFirstName?: string | null;
      status: 'ok';
      sourcePhotoUrl: string;
      sourcePhotoOrigin: PhotoSource | 'n/a';
      filestackUrl: string;
      mediaPhotoId: string;
      mediaUrl: string;
    }
  | {
      eventId: string;
      eventHandle: string | null;
      ownerFirstName?: string | null;
      fianceeFirstName?: string | null;
      status: 'skipped';
      reason: string;
      sourcePhotoUrl?: string;
      sourcePhotoOrigin?: PhotoSource;
      mediaPhotoId?: string;
      mediaUrl?: string;
    }
  | {
      eventId: string;
      eventHandle: string | null;
      ownerFirstName?: string | null;
      fianceeFirstName?: string | null;
      status: 'errored';
      reason: string;
      sourcePhotoUrl?: string;
      sourcePhotoOrigin?: PhotoSource;
    };

async function processEvent(
  client: JoyWebClient,
  eventId: string,
  styleId: StyleID,
  commit: boolean,
  force: boolean,
  saveImagesTo: string | null,
  logger: EventLogger,
): Promise<Outcome> {
  let event;
  try {
    event = await client.getEventById(eventId);
  } catch (err) {
    return { eventId, eventHandle: null, status: 'errored', reason: `fetch_event_failed: ${(err as Error).message}` };
  }
  if (!event) {
    return { eventId, eventHandle: null, status: 'skipped', reason: 'event_not_found' };
  }
  const eventHandle = event.website ?? null;
  logger.kv('handle', eventHandle);

  const ownerFirstName = event.info?.ownerFirstName?.trim() ?? '';
  const fianceeFirstName = event.info?.fianceeFirstName?.trim() ?? '';
  logger.kv('owner-first-name', ownerFirstName || null);
  logger.kv('fiancee-first-name', fianceeFirstName || null);
  if (!ownerFirstName || !fianceeFirstName) {
    return {
      eventId,
      eventHandle,
      ownerFirstName: ownerFirstName || null,
      fianceeFirstName: fianceeFirstName || null,
      status: 'skipped',
      reason: 'not_a_wedding_event',
    };
  }

  const sourcePhoto = extractSourcePhotoUrl(event);
  if (!sourcePhoto) {
    return { eventId, eventHandle, status: 'skipped', reason: 'no_source_photo' };
  }
  logger.kv('source-origin', sourcePhoto.source);
  logger.kv('source-url', sourcePhoto.url);

  const targetFilename = generatedFilenameSuffix(eventId);

  let existingMedia: Array<{ mediaId: string; assetId: string; url: string }>;
  try {
    existingMedia = await client.getEventMediaItems(eventId);
  } catch (err) {
    return {
      eventId,
      eventHandle,
      status: 'errored',
      reason: `fetch_event_media_failed: ${(err as Error).message}`,
    };
  }
  const priorGenerated = existingMedia.find((m) => m.assetId.startsWith(GENERATED_FILENAME_PREFIX));
  if (priorGenerated) {
    if (!force) {
      logger.kv('media-photo-id', priorGenerated.mediaId);
      logger.kv('media-url', priorGenerated.url);
      return {
        eventId,
        eventHandle,
        ownerFirstName,
        fianceeFirstName,
        status: 'skipped',
        reason: 'already_generated',
        sourcePhotoUrl: sourcePhoto.url,
        sourcePhotoOrigin: sourcePhoto.source,
        mediaPhotoId: priorGenerated.mediaId,
        mediaUrl: priorGenerated.url,
      };
    }
    if (!commit) {
      logger.kv('force-delete-dry-run-media-id', priorGenerated.mediaId);
      logger.kv('force-delete-dry-run-url', priorGenerated.url);
    } else {
      try {
        await client.deleteMedia(priorGenerated.mediaId);
      } catch (err) {
        return {
          eventId,
          eventHandle,
          status: 'errored',
          reason: `force_delete_failed: mediaId=${priorGenerated.mediaId} ${(err as Error).message}`,
          sourcePhotoUrl: sourcePhoto.url,
          sourcePhotoOrigin: sourcePhoto.source,
        };
      }
      logger.kv('force-deleted-media-id', priorGenerated.mediaId);
      logger.kv('force-deleted-url', priorGenerated.url);
    }
  }

  if (!commit) {
    logger.kv('dry-run-would-upload-as', targetFilename);
    return {
      eventId,
      eventHandle,
      ownerFirstName,
      fianceeFirstName,
      status: 'ok',
      sourcePhotoUrl: sourcePhoto.url,
      sourcePhotoOrigin: sourcePhoto.source,
      filestackUrl: '(dry-run)',
      mediaPhotoId: '(dry-run)',
      mediaUrl: '(dry-run)',
    };
  }

  let buffer: Buffer;
  const start = performance.now();
  try {
    buffer = await generateStylizedImage(styleId, sourcePhoto.url);
  } catch (err) {
    const reason =
      err instanceof GenerateStylizedImageError
        ? `gemini_failed:${err.message}`
        : `gemini_failed:${(err as Error).message}`;
    return {
      eventId,
      status: 'errored',
      reason,
      sourcePhotoUrl: sourcePhoto.url,
      sourcePhotoOrigin: sourcePhoto.source,
      eventHandle,
    };
  }
  debug(
    '%s gemini ok bytes=%d in %ds',
    eventId,
    buffer.length,
    ((performance.now() - start) / 1000).toFixed(2),
  );

  if (saveImagesTo) {
    const eventDir = join(saveImagesTo, eventId);
    mkdirSync(eventDir, { recursive: true });
    const diskPath = join(eventDir, targetFilename);
    writeFileSync(diskPath, buffer);
    logger.kv('saved-to-disk', diskPath);
  }

  let credentials;
  try {
    credentials = await client.getFilestackCredentials();
  } catch (err) {
    return {
      eventId,
      status: 'errored',
      reason: `filestack_credentials_failed: ${(err as Error).message}`,
      sourcePhotoUrl: sourcePhoto.url,
      sourcePhotoOrigin: sourcePhoto.source,
      eventHandle,
    };
  }

  let upload;
  try {
    upload = await uploadBufferToFilestack(buffer, targetFilename, eventId, credentials);
  } catch (err) {
    return {
      eventId,
      status: 'errored',
      reason: `filestack_upload_failed: ${(err as Error).message}`,
      sourcePhotoUrl: sourcePhoto.url,
      sourcePhotoOrigin: sourcePhoto.source,
      eventHandle,
    };
  }

  const photoInput: PhotoInput = {
    assetId: upload.assetId,
    handle: upload.handle,
    url: upload.url,
  };

  let response;
  try {
    response = await client.uploadMediaFromUrls(eventId, [photoInput]);
  } catch (err) {
    return {
      eventId,
      status: 'errored',
      reason: `upload_media_failed: ${(err as Error).message}`,
      sourcePhotoUrl: sourcePhoto.url,
      sourcePhotoOrigin: sourcePhoto.source,
      eventHandle,
    };
  }

  let finalStatus: UploadMediaResponse;
  try {
    finalStatus =
      response.status === 'COMPLETED'
        ? response
        : await pollUntilComplete(client, eventId, response.uploadId);
  } catch (err) {
    return {
      eventId,
      status: 'errored',
      reason: `rehost_poll_failed: ${(err as Error).message}`,
      sourcePhotoUrl: sourcePhoto.url,
      sourcePhotoOrigin: sourcePhoto.source,
      eventHandle,
    };
  }

  const ourUpload = finalStatus.uploads.find((u) => u.assetId === targetFilename) ?? finalStatus.uploads[0];
  if (!ourUpload || ourUpload.status === 'FAILED') {
    return {
      eventId,
      status: 'errored',
      reason: `rehost_failed: media_status=${ourUpload?.status ?? 'missing'}`,
      sourcePhotoUrl: sourcePhoto.url,
      sourcePhotoOrigin: sourcePhoto.source,
      eventHandle,
    };
  }
  if (ourUpload.status !== 'COMPLETED') {
    return {
      eventId,
      status: 'errored',
      reason: `rehost_not_completed: media_status=${ourUpload.status}`,
      sourcePhotoUrl: sourcePhoto.url,
      sourcePhotoOrigin: sourcePhoto.source,
      eventHandle,
    };
  }

  const mediaPhotoId = ourUpload.photo?.id ?? ourUpload.id ?? finalStatus.uploadId;
  const mediaUrl = ourUpload.photo?.url ?? '';

  return {
    eventId,
    eventHandle,
    ownerFirstName,
    fianceeFirstName,
    status: 'ok',
    sourcePhotoUrl: sourcePhoto.url,
    sourcePhotoOrigin: sourcePhoto.source,
    filestackUrl: upload.url,
    mediaPhotoId,
    mediaUrl,
  };
}

function buildRunSummary(args: {
  startedAt: Date;
  completedAt: Date;
  commit: boolean;
  styleId: StyleID;
  delayMs: number;
  flags: string;
  outcomes: Outcome[];
  logLines: string[];
}): string {
  const { startedAt, completedAt, commit, styleId, delayMs, flags, outcomes, logLines } = args;
  const ok = outcomes.filter((o) => o.status === 'ok') as Extract<Outcome, { status: 'ok' }>[];
  const skipped = outcomes.filter((o) => o.status === 'skipped') as Extract<Outcome, { status: 'skipped' }>[];
  const errored = outcomes.filter((o) => o.status === 'errored') as Extract<Outcome, { status: 'errored' }>[];
  const lines: string[] = [
    `Started:   ${startedAt.toISOString()}`,
    `Completed: ${completedAt.toISOString()}`,
    `Duration:  ${((completedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1)}s`,
    `Mode:      ${commit ? 'COMMIT' : 'DRY-RUN'}`,
    `Flags:     ${flags || '(none)'}`,
    `Style:     ${styleId}`,
    `Delay:     ${delayMs}ms`,
    `Total:     ${outcomes.length}  ok=${ok.length}  skipped=${skipped.length}  errored=${errored.length}`,
    '',
    'OK',
  ];
  if (ok.length === 0) lines.push('  (none)');
  for (const o of ok) {
    lines.push(`  ${o.eventId}  handle=${o.eventHandle ?? '-'}  source-origin=${o.sourcePhotoOrigin}  mediaPhotoId=${o.mediaPhotoId}  mediaUrl=${o.mediaUrl}`);
  }
  lines.push('', 'SKIPPED');
  if (skipped.length === 0) lines.push('  (none)');
  for (const o of skipped) {
    lines.push(`  ${o.eventId}  handle=${o.eventHandle ?? '-'}  ${o.reason}`);
  }
  lines.push('', 'ERRORED');
  if (errored.length === 0) lines.push('  (none)');
  for (const o of errored) {
    const src = o.sourcePhotoUrl ? `  source-origin=${o.sourcePhotoOrigin}  source-url=${o.sourcePhotoUrl}` : '';
    lines.push(`  ${o.eventId}  handle=${o.eventHandle ?? '-'}  ${o.reason}${src}`);
  }
  lines.push('', 'LOGS', '');
  if (logLines.length === 0) lines.push('  (none)');
  else lines.push(...logLines);
  return lines.join('\n') + '\n';
}

async function main() {
  const startedAt = new Date();
  const {
    eventIds,
    commit,
    force,
    delayMs,
    concurrency,
    styleId,
    resultsOutput,
    erroredOutput,
    skippedOutput,
    saveImagesTo,
  } = parseArgs();

  if (saveImagesTo) {
    mkdirSync(saveImagesTo, { recursive: true });
    console.log(`Saving generated images to: ${saveImagesTo}`);
  }
  debug(
    'Starting: %d events, commit=%s, delayMs=%d, styleId=%s',
    eventIds.length,
    commit,
    delayMs,
    styleId,
  );
  if (!commit) console.log('DRY-RUN (pass --commit to generate + upload)');
  console.log(`Throttle: ${delayMs}ms before processing each event`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`Style: ${styleId}`);

  console.log('Authenticating…');
  const userJwt = await exchangeIdTokenForUserJwt(JOY_WEB_GRAPHQL_URL, JOY_WEB_ID_TOKEN);
  console.log('Authenticated.');
  const client = new JoyWebClient(JOY_WEB_GRAPHQL_URL, userJwt);

  console.log(`\nProcessing ${eventIds.length} event(s)…`);

  const stream = concurrency === 1;
  const outcomes: Outcome[] = new Array(eventIds.length);
  const perEventLogs: string[][] = new Array(eventIds.length);
  let nextIdx = 0;
  let completedCount = 0;
  const total = eventIds.length;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIdx++;
      if (i >= total) return;
      if (delayMs > 0) await sleep(delayMs);
      const eventId = eventIds[i]!;
      const logger = new EventLogger(stream);

      // Stream mode (concurrency=1): banner at start; completion order == input order.
      if (stream) {
        const count = ++completedCount;
        logger.line(`\n────────── [${count}/${total}] ${eventId} ──────────`);
      }

      const outcome = await processEvent(
        client,
        eventId,
        styleId,
        commit,
        force,
        saveImagesTo,
        logger,
      );
      logOutcomeResult(outcome, logger);

      // Parallel mode: assign completion-order index at flush time so terminal
      // counts go 1, 2, 3, ... monotonically as events finish.
      if (!stream) {
        const count = ++completedCount;
        logger.lines.unshift(`\n────────── [${count}/${total}] ${eventId} ──────────`);
      }

      logger.flushToConsole();
      outcomes[i] = outcome;
      perEventLogs[i] = logger.lines;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const RUN_LOG_LINES: string[] = [];
  for (const lines of perEventLogs) {
    if (lines) RUN_LOG_LINES.push(...lines);
  }

  const ok = outcomes.filter((o) => o.status === 'ok');
  const skipped = outcomes.filter((o) => o.status === 'skipped');
  const errored = outcomes.filter((o) => o.status === 'errored');
  console.log(
    `\nSummary: ${outcomes.length} total, ${ok.length} ok, ${skipped.length} skipped, ${errored.length} errored`,
  );

  if (ok.length > 0) {
    const lines =
      ok
        .map((o) => {
          const r = o as Extract<Outcome, { status: 'ok' }>;
          return `${r.eventId}\t${r.eventHandle ?? '-'}\t${r.sourcePhotoOrigin}\t${r.sourcePhotoUrl}\t${r.filestackUrl}\t${r.mediaPhotoId}\t${r.mediaUrl}`;
        })
        .join('\n') + '\n';
    writeFileSync(resultsOutput, lines);
    console.log(`Wrote ${ok.length} result line(s) to ${resultsOutput}`);
  }
  if (skipped.length > 0) {
    const lines =
      skipped
        .map((o) => {
          const r = o as Extract<Outcome, { status: 'skipped' }>;
          return `${r.eventId}\t${r.eventHandle ?? '-'}\t${r.reason}`;
        })
        .join('\n') + '\n';
    writeFileSync(skippedOutput, lines);
    console.log(`Wrote ${skipped.length} skipped line(s) to ${skippedOutput}`);
  }
  if (errored.length > 0) {
    const lines =
      errored
        .map((o) => {
          const r = o as Extract<Outcome, { status: 'errored' }>;
          return `${r.eventId}\t${r.eventHandle ?? '-'}\t${r.sourcePhotoOrigin ?? '-'}\t${r.sourcePhotoUrl ?? '-'}\t${r.reason}`;
        })
        .join('\n') + '\n';
    writeFileSync(erroredOutput, lines);
    console.log(`Wrote ${errored.length} errored line(s) to ${erroredOutput}`);
  }

  mkdirSync(RUN_SUMMARIES_DIR, { recursive: true });
  const completedAt = new Date();
  const flags = Bun.argv.slice(2).join(' ');
  const summary = buildRunSummary({
    startedAt,
    completedAt,
    commit,
    styleId,
    delayMs,
    flags,
    outcomes,
    logLines: RUN_LOG_LINES,
  });
  const summaryBasename = formatHumanFilenameTimestamp(startedAt);
  const summaryPath = join(RUN_SUMMARIES_DIR, `${summaryBasename}.txt`);
  writeFileSync(summaryPath, summary);
  console.log(`Wrote run summary to ${summaryPath}`);

  const reportHeader: RunHeader = {
    started: startedAt.toISOString(),
    completed: completedAt.toISOString(),
    duration: `${((completedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1)}s`,
    mode: commit ? 'COMMIT' : 'DRY-RUN',
    flags: flags || '(none)',
    style: styleId,
    delay: `${delayMs}ms`,
    total: `${outcomes.length}  ok=${ok.length}  skipped=${skipped.length}  errored=${errored.length}`,
  };
  const reportEvents: EventReportRecord[] = outcomes.map((o, i) => {
    const logs = perEventLogs[i] ?? [];
    const base = {
      eventId: o.eventId,
      handle: o.eventHandle,
      ownerFirstName: o.ownerFirstName ?? null,
      fianceeFirstName: o.fianceeFirstName ?? null,
      status: o.status as string,
      logLines: logs,
    };
    if (o.status === 'ok') {
      return {
        ...base,
        sourceOrigin: o.sourcePhotoOrigin,
        sourceUrl: o.sourcePhotoUrl,
        mediaPhotoId: o.mediaPhotoId,
        mediaUrl: o.mediaUrl,
        reason: null,
      };
    }
    if (o.status === 'skipped') {
      return {
        ...base,
        sourceOrigin: o.sourcePhotoOrigin ?? null,
        sourceUrl: o.sourcePhotoUrl ?? null,
        mediaPhotoId: o.mediaPhotoId ?? null,
        mediaUrl: o.mediaUrl ?? null,
        reason: o.reason,
      };
    }
    return {
      ...base,
      sourceOrigin: o.sourcePhotoOrigin ?? null,
      sourceUrl: o.sourcePhotoUrl ?? null,
      mediaPhotoId: null,
      mediaUrl: null,
      reason: o.reason,
    };
  });
  const htmlPath = join(RUN_SUMMARIES_DIR, `${summaryBasename}.html`);
  writeFileSync(htmlPath, buildRunHtmlReport({ header: reportHeader, events: reportEvents }));
  console.log(`Wrote HTML report to ${htmlPath}`);

  if (errored.length > 0) process.exit(1);
}

await main();
