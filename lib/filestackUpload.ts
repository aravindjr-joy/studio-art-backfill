import * as filestack from 'filestack-js';

import type { FilestackCredentials } from './joyWebClient.ts';

export interface FilestackUploadResult {
  assetId: string;
  handle: string;
  url: string;
}

export async function uploadBufferToFilestack(
  buffer: Buffer,
  filename: string,
  eventId: string,
  credentials: FilestackCredentials,
): Promise<FilestackUploadResult> {
  const client = filestack.init(credentials.apiKey, {
    security: { policy: credentials.policy, signature: credentials.signature },
  });

  const res = await client.upload(
    buffer,
    {},
    {
      location: 'azure',
      container: eventId,
      path: filename,
      filename,
      mimetype: 'image/png',
    },
  );

  if (!res?.handle || !res?.url) {
    throw new Error(`Filestack upload returned unexpected shape: ${JSON.stringify(res)}`);
  }

  const url = `${res.url}?policy=${credentials.policy}&signature=${credentials.signature}`;
  return {
    assetId: filename,
    handle: res.handle,
    url,
  };
}
