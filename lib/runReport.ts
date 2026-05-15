export interface RunHeader {
  started: string;
  completed: string;
  duration: string;
  mode: string;
  flags: string;
  style: string;
  delay: string;
  total: string;
}

export interface EventReportRecord {
  eventId: string;
  handle: string | null;
  ownerFirstName: string | null;
  fianceeFirstName: string | null;
  sourceOrigin: string | null;
  sourceUrl: string | null;
  mediaPhotoId: string | null;
  mediaUrl: string | null;
  status: string | null;
  reason: string | null;
  logLines: string[];
}

const PLACEHOLDER_DATE = 'August 13, 2026';
const PLACEHOLDER_VENUE = '4 pm at The Falconwood at Beaver Island State Park';
const PLACEHOLDER_ADDRESS = '107 Beaver Is Pk Rd | , New York';
const CARD_FRAME_URL =
  'https://withjoy.com/media/paper/7abbd6d4-6138-4f98-8065-878e2924486c.8e80cadb847df7e1f42c5fd977b0efad52fbe3c8.png?rendition=medium';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isUsableUrl(url: string | null): boolean {
  return !!url && url !== '(dry-run)' && /^https?:\/\//i.test(url);
}

function namesLine(event: EventReportRecord): string {
  const a = event.ownerFirstName ?? '';
  const b = event.fianceeFirstName ?? '';
  if (a && b) return `${a} & ${b}`.toUpperCase();
  if (a) return a.toUpperCase();
  if (b) return b.toUpperCase();
  return 'NAME1 & NAME2';
}

function eventCardHtml(event: EventReportRecord): string {
  const handle = event.handle;
  const handleHeading = handle
    ? `<a href="https://withjoy.com/${escapeHtml(handle)}/edit" target="_blank" rel="noopener">${escapeHtml(handle)}</a>`
    : '<span class="muted">(no handle)</span>';
  const sourceUrl = event.sourceUrl!;
  const mediaUrl = event.mediaUrl!;
  const isSkipped = event.status === 'skipped';
  const badge = isSkipped
    ? `<span class="badge badge-skipped">skipped: ${escapeHtml(event.reason ?? '')}</span>`
    : '';
  const generatedLabel = isSkipped ? 'Existing generated (card mock)' : 'Generated (card mock)';
  const names = escapeHtml(namesLine(event));
  const logsBlock =
    event.logLines.length > 0
      ? `
      <details class="event-logs">
        <summary>Logs</summary>
        <pre>${escapeHtml(event.logLines.join('\n'))}</pre>
      </details>`
      : '';
  return `
  <article class="event">
    <header>
      <h2>${handleHeading}${badge}</h2>
      <div class="event-id">${escapeHtml(event.eventId)}</div>
    </header>
    <div class="images">
      <figure>
        <figcaption>Source <span class="muted">(${escapeHtml(event.sourceOrigin ?? '-')})</span></figcaption>
        <a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener">
          <img src="${escapeHtml(sourceUrl)}" alt="Source photo for ${escapeHtml(event.eventId)}" loading="lazy" />
        </a>
      </figure>
      <figure>
        <figcaption>${generatedLabel}</figcaption>
        <a href="${escapeHtml(mediaUrl)}" target="_blank" rel="noopener" class="card-mock-link">
          <div class="card-mock">
            <div class="card-canvas">
              <div class="card-photo-layer">
                <img src="${escapeHtml(mediaUrl)}" alt="Generated photo for ${escapeHtml(event.eventId)}" loading="lazy" />
              </div>
              <div class="card-frame-layer"></div>
              <div class="card-tag-layer">the wedding of</div>
              <div class="card-names-layer">${names}</div>
              <div class="card-details-layer">${escapeHtml(PLACEHOLDER_DATE)}
${escapeHtml(PLACEHOLDER_VENUE)}
${escapeHtml(PLACEHOLDER_ADDRESS)}</div>
            </div>
          </div>
        </a>
      </figure>
    </div>${logsBlock}
  </article>`;
}

export function buildRunHtmlReport(input: { header: RunHeader; events: EventReportRecord[] }): string {
  const { header, events } = input;
  const renderable = events.filter(
    (e) =>
      isUsableUrl(e.sourceUrl) &&
      isUsableUrl(e.mediaUrl) &&
      (e.status === 'ok' ||
        (e.status === 'skipped' && e.reason === 'already_generated')),
  );
  const okCount = renderable.filter((e) => e.status === 'ok').length;
  const skippedCount = renderable.length - okCount;
  const headingCountLabel =
    skippedCount > 0
      ? `${renderable.length} (ok=${okCount}, already-generated=${skippedCount})`
      : `${renderable.length}`;

  const summaryRows = [
    ['Mode', header.mode],
    ['Flags', header.flags],
    ['Style', header.style],
    ['Delay', header.delay],
    ['Duration', header.duration],
    ['Total', header.total],
    ['Started', header.started],
    ['Completed', header.completed],
  ]
    .map(([k, v]) => `<div class="row"><dt>${escapeHtml(k!)}</dt><dd>${escapeHtml(v!)}</dd></div>`)
    .join('');

  const cards = renderable.map(eventCardHtml).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Run Summary — ${escapeHtml(header.started)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;1,400&family=Jost:wght@400&display=swap">
  <style>
    :root {
      color-scheme: light;
      --bg: #fafafa;
      --surface: #ffffff;
      --border: #e5e5e5;
      --text: #1a1a1a;
      --muted: #6b7280;
      --accent: #2563eb;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif;
      line-height: 1.5;
    }
    .container { max-width: 1100px; margin: 0 auto; padding: 32px 24px 64px; }
    h1 { margin: 0 0 4px; font-size: 28px; }
    h1 + .subtitle { color: var(--muted); margin: 0 0 24px; font-size: 14px; }
    h2 { margin: 0; font-size: 20px; }
    h2 a { color: var(--accent); text-decoration: none; }
    h2 a:hover { text-decoration: underline; }
    .muted { color: var(--muted); font-weight: normal; font-size: 0.9em; }
    .summary {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px 20px;
      margin-bottom: 32px;
    }
    .summary dl { margin: 0; }
    .summary .row { display: grid; grid-template-columns: 120px 1fr; gap: 12px; padding: 4px 0; }
    .summary dt { margin: 0; color: var(--muted); font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; }
    .summary dd { margin: 0; font-size: 14px; word-break: break-word; }
    .section-heading { margin: 0 0 16px; font-size: 18px; }
    .event {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .event header { margin-bottom: 12px; }
    .event h2 { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; letter-spacing: 0.02em; text-transform: uppercase; }
    .badge-skipped { background: #fef3c7; color: #92400e; border: 1px solid #fde68a; }
    .event-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); }
    .images { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    figure { margin: 0; }
    figcaption { font-size: 12px; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em; }
    figure img { display: block; max-width: 100%; height: auto; border: 1px solid var(--border); border-radius: 4px; background: #f3f4f6; }
    .event-logs { margin-top: 12px; }
    .event-logs summary { cursor: pointer; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .event-logs pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: #f6f7f8; padding: 12px; border-radius: 4px; overflow-x: auto; margin: 8px 0 0; word-break: break-word; white-space: pre-wrap; }
    .card-mock-link { display: block; text-decoration: none; color: inherit; }
    .card-mock {
      container-type: inline-size;
      aspect-ratio: 378 / 522;
      width: 100%;
      background: #ffffff;
      position: relative;
      overflow: hidden;
    }
    .card-canvas { position: absolute; inset: 0; }
    .card-photo-layer {
      position: absolute;
      left: 16.402%;
      top: 7.977%;
      width: 62.434%;
      height: 59.004%;
      overflow: hidden;
    }
    .card-photo-layer img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
      border: none;
      border-radius: 0;
      background: transparent;
    }
    .card-frame-layer {
      position: absolute;
      left: -2.381%;
      top: -1.724%;
      width: 100%;
      height: 100%;
      background-image: url("${CARD_FRAME_URL}");
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
      pointer-events: none;
    }
    .card-tag-layer,
    .card-names-layer,
    .card-details-layer {
      position: absolute;
      color: rgb(0, 0, 0);
      text-align: center;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .card-tag-layer {
      left: 33.069%;
      top: 4.406%;
      width: 29.101%;
      font-family: 'Playfair Display', Georgia, serif;
      font-style: italic;
      font-weight: 400;
      font-size: 2.381cqi;
      line-height: 1.33;
      letter-spacing: 0.08em;
    }
    .card-names-layer {
      left: 7.937%;
      top: 72.797%;
      width: 79.365%;
      font-family: 'Playfair Display', Georgia, serif;
      font-weight: 400;
      font-size: 4.497cqi;
      line-height: 1.33;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .card-details-layer {
      left: 7.937%;
      top: 78.736%;
      width: 79.365%;
      font-family: 'Jost', system-ui, sans-serif;
      font-weight: 400;
      font-size: 2.646cqi;
      line-height: 1.8;
      letter-spacing: 0.1em;
    }
    @media (max-width: 600px) {
      .images { grid-template-columns: 1fr; }
      .summary .row { grid-template-columns: 1fr; gap: 0; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Run Summary</h1>
    <p class="subtitle">${escapeHtml(header.started)}</p>
    <section class="summary">
      <dl>${summaryRows}</dl>
    </section>
    <h2 class="section-heading">Events with generated images (${headingCountLabel})</h2>
    ${cards || '<p class="muted">No events to display.</p>'}
  </div>
</body>
</html>`;
}
