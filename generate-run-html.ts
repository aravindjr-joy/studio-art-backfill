import { readFileSync, writeFileSync } from 'node:fs';

import {
  buildRunHtmlReport,
  type EventReportRecord,
  type RunHeader,
} from './lib/runReport.ts';

type Args = { inputPath: string; outputPath: string };

function parseArgs(): Args {
  const argv = Bun.argv.slice(2);
  let inputPath: string | null = null;
  let outputPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--output') {
      const value = argv[++i];
      if (!value) throw new Error('--output requires a path');
      outputPath = value;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else if (!inputPath) {
      inputPath = arg;
    } else {
      throw new Error(`Unexpected positional arg: ${arg}`);
    }
  }
  if (!inputPath) {
    throw new Error('Usage: bun run generate-run-html.ts <path-to-summary.txt> [--output path.html]');
  }
  if (!outputPath) {
    outputPath = inputPath.endsWith('.txt') ? inputPath.replace(/\.txt$/, '.html') : `${inputPath}.html`;
  }
  return { inputPath, outputPath };
}

function parseHeader(lines: string[]): RunHeader {
  const map = new Map<string, string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) break;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim().toLowerCase();
    const value = trimmed.slice(idx + 1).trim();
    map.set(key, value);
  }
  const req = (k: string): string => {
    const v = map.get(k);
    if (v === undefined) throw new Error(`Run summary header missing field: ${k}`);
    return v;
  };
  return {
    started: req('started'),
    completed: req('completed'),
    duration: req('duration'),
    mode: req('mode'),
    flags: map.get('flags') ?? '(none)',
    style: req('style'),
    delay: req('delay'),
    total: req('total'),
  };
}

const BANNER_RE = /^──────────\s*\[\d+\/\d+\]\s*([a-f0-9-]{8,})\s*──────────/;
const KV_RE = /^\s{2,}([a-z][a-z0-9-]*):\s*(.*)$/;

function nullableValue(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '-') return null;
  return trimmed;
}

function emptyRecord(eventId: string): EventReportRecord {
  return {
    eventId,
    handle: null,
    ownerFirstName: null,
    fianceeFirstName: null,
    sourceOrigin: null,
    sourceUrl: null,
    mediaPhotoId: null,
    mediaUrl: null,
    status: null,
    reason: null,
    logLines: [],
  };
}

function parseLogs(logLines: string[]): EventReportRecord[] {
  const events: EventReportRecord[] = [];
  let current: EventReportRecord | null = null;
  for (const line of logLines) {
    const banner = line.match(BANNER_RE);
    if (banner) {
      if (current) events.push(current);
      current = emptyRecord(banner[1]!);
      current.logLines.push(line);
      continue;
    }
    if (!current) continue;
    current.logLines.push(line);
    const kv = line.match(KV_RE);
    if (!kv) continue;
    const key = kv[1]!;
    const value = nullableValue(kv[2]!);
    switch (key) {
      case 'handle': current.handle = value; break;
      case 'owner-first-name': current.ownerFirstName = value; break;
      case 'fiancee-first-name': current.fianceeFirstName = value; break;
      case 'source-origin': current.sourceOrigin = value; break;
      case 'source-url': current.sourceUrl = value; break;
      case 'media-photo-id': current.mediaPhotoId = value; break;
      case 'media-url': current.mediaUrl = value; break;
      case 'status': current.status = value; break;
      case 'reason': current.reason = value; break;
    }
  }
  if (current) events.push(current);
  // Trim trailing blank lines from each event's log block.
  for (const ev of events) {
    while (ev.logLines.length > 0 && ev.logLines[ev.logLines.length - 1]!.trim() === '') {
      ev.logLines.pop();
    }
  }
  return events;
}

function parseRunSummary(text: string): { header: RunHeader; events: EventReportRecord[] } {
  const lines = text.split(/\r?\n/);
  const logsIdx = lines.findIndex((l) => l.trim() === 'LOGS');
  if (logsIdx === -1) {
    throw new Error('Run summary file is missing a LOGS section.');
  }
  const header = parseHeader(lines.slice(0, logsIdx));
  const events = parseLogs(lines.slice(logsIdx + 1));
  return { header, events };
}

function main(): void {
  const { inputPath, outputPath } = parseArgs();
  const text = readFileSync(inputPath, 'utf8');
  const { header, events } = parseRunSummary(text);
  const html = buildRunHtmlReport({ header, events });
  writeFileSync(outputPath, html);
  console.log(`Wrote ${outputPath}`);
}

main();
