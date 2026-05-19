import { readFileSync } from 'node:fs';
import z from 'zod';

import {
  exchangeIdTokenForUserJwt,
  JoyWebClient,
} from './lib/joyWebClient.ts';

const GENERATED_FILENAME_PREFIX = 'studio-gouache-';

const JOY_WEB_GRAPHQL_URL = z
  .string({ message: 'JOY_WEB_GRAPHQL_URL is required' })
  .url()
  .parse(Bun.env.JOY_WEB_GRAPHQL_URL);

const JOY_WEB_ID_TOKEN = z
  .string({ message: 'JOY_WEB_ID_TOKEN is required' })
  .parse(Bun.env.JOY_WEB_ID_TOKEN);

type CliArgs = {
  eventUrls: string[];
  commit: boolean;
};

function extractHandle(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  try {
    const parsed = new URL(trimmed);
    const segment = parsed.pathname.split('/').find((s) => s.length > 0);
    if (segment) return segment;
  } catch {
    // Not a full URL — treat as a bare handle
    const bare = trimmed.split('/')[0];
    if (bare) return bare;
  }
  throw new Error(`Cannot extract handle from: ${rawUrl}`);
}

function parseArgs(): CliArgs {
  const argv = Bun.argv.slice(2);
  let eventUrls: string[] = [];
  let commit = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--commit') {
      commit = true;
    } else if (arg === '--event-urls') {
      const value = argv[++i];
      if (!value) throw new Error('--event-urls requires a value');
      eventUrls = value.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--file') {
      const path = argv[++i];
      if (!path) throw new Error('--file requires a path');
      eventUrls = readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('#'));
    } else {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }

  if (eventUrls.length === 0) {
    throw new Error(
      'No event URLs provided. Pass --event-urls URL1,URL2 or --file path',
    );
  }

  return { eventUrls, commit };
}

async function main() {
  const { eventUrls, commit } = parseArgs();

  if (!commit) console.log('DRY-RUN (pass --commit to actually delete)');

  console.log('Authenticating…');
  const userJwt = await exchangeIdTokenForUserJwt(JOY_WEB_GRAPHQL_URL, JOY_WEB_ID_TOKEN);
  console.log('Authenticated.');

  const client = new JoyWebClient(JOY_WEB_GRAPHQL_URL, userJwt);

  let deleted = 0;
  let skipped = 0;
  let errored = 0;

  for (const rawUrl of eventUrls) {
    let handle: string;
    try {
      handle = extractHandle(rawUrl);
    } catch (err) {
      console.log(`${rawUrl}  errored: ${(err as Error).message}`);
      errored++;
      continue;
    }

    console.log(`\n────────── ${handle} ──────────`);

    let media: Array<{ mediaId: string; assetId: string; url: string }>;
    try {
      media = await client.getEventMediaItemsByHandle(handle);
    } catch (err) {
      console.log(`  errored: ${(err as Error).message}`);
      errored++;
      continue;
    }

    const matches = media.filter((m) => m.assetId.startsWith(GENERATED_FILENAME_PREFIX));

    if (matches.length === 0) {
      console.log('  no generated photo found');
      skipped++;
      continue;
    }

    for (const item of matches) {
      if (!commit) {
        console.log(`  would delete: mediaId=${item.mediaId}  url=${item.url}`);
      } else {
        try {
          await client.deleteMedia(item.mediaId);
          console.log(`  deleted: mediaId=${item.mediaId}  url=${item.url}`);
          deleted++;
        } catch (err) {
          console.log(
            `  errored: failed to delete mediaId=${item.mediaId}: ${(err as Error).message}`,
          );
          errored++;
        }
      }
    }

    if (!commit) skipped += matches.length;
  }

  console.log(
    `\nSummary: ${eventUrls.length} processed, ${commit ? deleted : 0} deleted` +
      (commit ? '' : ` (${skipped} would delete)`) +
      `, ${errored} errored`,
  );

  if (errored > 0) process.exit(1);
}

await main();
