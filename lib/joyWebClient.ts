import axios, { AxiosError } from 'axios';

type Headers = { Authorization: string; 'Content-Type': string };

export interface SupportedHeaderPhotoLayoutSchema {
  photos?: ReadonlyArray<{ id: string; url: string }>;
}

export interface EventByIdResponse {
  id: string;
  website?: string | null;
  info?: {
    ownerFirstName?: string | null;
    fianceeFirstName?: string | null;
  } | null;
  photo?: { id: string; url: string } | null;
  photoV2?: { __typename?: string; url?: string | null } | null;
  firebasePhotoPath?: string | null;
  eventDesign?: {
    activeWebsiteHeaderPresentationLayout?: {
      dataJSON?: SupportedHeaderPhotoLayoutSchema;
    } | null;
  } | null;
}

export interface FilestackCredentials {
  apiKey: string;
  policy: string;
  signature: string;
}

export interface PhotoInput {
  assetId: string;
  handle?: string;
  url: string;
}

export type UploadStatus = 'COMPLETED' | 'IN_PROGRESS';
export type MediaStatus = 'COMPLETED' | 'FAILED' | 'IN_PROGRESS' | 'NOT_STARTED';

export interface MediaUpload {
  id: string | null;
  assetId: string;
  status: MediaStatus;
  photo?: { id: string; url: string; height?: number; width?: number } | null;
}

export interface UploadMediaResponse {
  id: string | null;
  uploadId: string;
  status: UploadStatus;
  attemptInMs: number;
  uploads: MediaUpload[];
}

export interface EventMediaPhoto {
  id: string;
  photo: { id: string; url: string; assetId?: string | null } | null;
}

export async function exchangeIdTokenForUserJwt(
  graphqlUrl: string,
  idToken: string,
): Promise<string> {
  const query = `query AuthenticateForGeneratedPhoto($idToken: String!) {
    authenticateUser(authToken: $idToken) { userJWT }
  }`;
  let res;
  try {
    res = await axios.post(
      graphqlUrl,
      { query, variables: { idToken } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30_000 },
    );
  } catch (err) {
    const detail =
      err instanceof AxiosError ? JSON.stringify(err.response?.data ?? err.message) : String(err);
    throw new Error(`authenticateUser request failed: ${detail}`);
  }
  if (res.data?.errors) {
    throw new Error(`authenticateUser GraphQL error: ${JSON.stringify(res.data.errors)}`);
  }
  const userJwt = res.data?.data?.authenticateUser?.userJWT;
  if (typeof userJwt !== 'string' || !userJwt) {
    throw new Error(`authenticateUser returned no userJWT: ${JSON.stringify(res.data)}`);
  }
  return userJwt;
}

export class JoyWebClient {
  private headers: Headers;

  constructor(
    private graphqlUrl: string,
    authToken: string,
  ) {
    this.headers = {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    };
  }

  private async query<T>(query: string, variables: Record<string, unknown>, op: string): Promise<T> {
    let res;
    try {
      res = await axios.post(
        this.graphqlUrl,
        { query, variables },
        { headers: this.headers, timeout: 60_000 },
      );
    } catch (err) {
      const detail =
        err instanceof AxiosError ? JSON.stringify(err.response?.data ?? err.message) : String(err);
      throw new Error(`${op} request failed: ${detail}`);
    }
    if (res.data?.errors) {
      throw new Error(`${op} GraphQL error: ${JSON.stringify(res.data.errors)}`);
    }
    if (!res.data?.data) {
      throw new Error(`${op} empty response: ${JSON.stringify(res.data)}`);
    }
    return res.data.data as T;
  }

  async getEventById(eventId: string): Promise<EventByIdResponse | null> {
    const query = `query GetEventForGeneratedPhoto($id: ID!) {
      eventById(id: $id) {
        id
        website
        info {
          ownerFirstName
          fianceeFirstName
        }
        photo { id url }
        photoV2 {
          __typename
          ... on DefaultPagePhoto { url }
          ... on Photo { url }
        }
        firebasePhotoPath
        eventDesign(purpose: live) {
          activeWebsiteHeaderPresentationLayout {
            dataJSON
          }
        }
      }
    }`;
    const data = await this.query<{ eventById: EventByIdResponse | null }>(
      query,
      { id: eventId },
      'eventById',
    );
    return data.eventById;
  }

  async getEventMediaItems(eventId: string): Promise<Array<{ mediaId: string; assetId: string; url: string }>> {
    const query = `query GetEventMediaForGeneratedPhoto($id: ID!) {
      eventById(id: $id) {
        id
        media {
          ... on MediaPhoto {
            id
            photo { id assetId url }
          }
        }
      }
    }`;
    const data = await this.query<{
      eventById: { media?: Array<EventMediaPhoto> | null } | null;
    }>(query, { id: eventId }, 'getEventMedia');
    const media = data.eventById?.media ?? [];
    return media
      .map((m) => ({ mediaId: m?.id, assetId: m?.photo?.assetId, url: m?.photo?.url }))
      .filter(
        (m): m is { mediaId: string; assetId: string; url: string } =>
          typeof m.mediaId === 'string' && m.mediaId.length > 0 &&
          typeof m.assetId === 'string' && m.assetId.length > 0 &&
          typeof m.url === 'string' && m.url.length > 0,
      );
  }

  async getEventMediaItemsByHandle(
    handle: string,
  ): Promise<Array<{ mediaId: string; assetId: string; url: string }>> {
    const query = `query GetEventMediaByHandleForDelete($handle: String!) {
      eventByName(name: $handle) {
        id
        media {
          ... on MediaPhoto {
            id
            photo { id assetId url }
          }
        }
      }
    }`;
    const data = await this.query<{
      eventByName: { id: string; media?: Array<EventMediaPhoto> | null } | null;
    }>(query, { handle }, 'getEventMediaByHandle');
    const media = data.eventByName?.media ?? [];
    return media
      .map((m) => ({ mediaId: m?.id, assetId: m?.photo?.assetId, url: m?.photo?.url }))
      .filter(
        (m): m is { mediaId: string; assetId: string; url: string } =>
          typeof m.mediaId === 'string' && m.mediaId.length > 0 &&
          typeof m.assetId === 'string' && m.assetId.length > 0 &&
          typeof m.url === 'string' && m.url.length > 0,
      );
  }

  async deleteMedia(mediaId: string): Promise<void> {
    const query = `mutation DeleteMediaForGeneratedPhoto($id: ID!) {
      deleteMedia(id: $id)
    }`;
    await this.query<{ deleteMedia: null }>(query, { id: mediaId }, 'deleteMedia');
  }

  async getFilestackCredentials(): Promise<FilestackCredentials> {
    const query = `query FilestackForGeneratedPhoto {
      filestack { apiKey policy signature }
    }`;
    const data = await this.query<{ filestack: FilestackCredentials }>(query, {}, 'filestack');
    return data.filestack;
  }

  async uploadMediaFromUrls(eventId: string, photos: PhotoInput[]): Promise<UploadMediaResponse> {
    const query = `mutation UploadMediaFromUrlsForGeneratedPhoto($payload: createMediaFromUrlsInput!) {
      uploadMediaFromUrls(payload: $payload) {
        id
        uploadId
        status
        attemptInMs
        uploads {
          id
          assetId
          status
          photo { id url height width }
        }
      }
    }`;
    const data = await this.query<{ uploadMediaFromUrls: UploadMediaResponse }>(
      query,
      { payload: { eventId, photos } },
      'uploadMediaFromUrls',
    );
    return data.uploadMediaFromUrls;
  }

  async uploadMediaStatus(eventId: string, uploadId: string): Promise<UploadMediaResponse> {
    const query = `query UploadMediaStatusForGeneratedPhoto($eventId: ID!, $uploadId: ID!) {
      uploadMediaStatus(eventId: $eventId, uploadId: $uploadId) {
        id
        uploadId
        status
        attemptInMs
        uploads {
          id
          assetId
          status
          photo { id url height width }
        }
      }
    }`;
    const data = await this.query<{ uploadMediaStatus: UploadMediaResponse }>(
      query,
      { eventId, uploadId },
      'uploadMediaStatus',
    );
    return data.uploadMediaStatus;
  }
}

export type PhotoSource = 'headerLayout' | 'photoV2Url' | 'photo' | 'firebasePhotoPath';

export interface SourcePhoto {
  url: string;
  source: PhotoSource;
}

const DEFAULT_PHOTO_URL_PREFIXES: ReadonlyArray<string> = [
  'https://withjoy.com/assets/public/wedding-website/designs-gallery/default-assets/',
  'https://withjoy.com/assets/public/marcom-prod/wedding-website-gallery/gallery_thumbnails/default_preview_images/',
  'https://withjoy.com/assets/public/defaultwebsitephotos/',
  'https://withjoy.com/assets/public/createwedding/seed-wedding-templates/',
];

const STOCK_PHOTO_FILENAME_PATTERNS: ReadonlyArray<RegExp> = [
  /^classic_wedding_/i,
  /-unsplash/i,
];

const STOCK_PHOTO_URLS: ReadonlyArray<string> = [
  'https://withjoy.com/media/ea08b6c9814abe8d85f1f6999d73bd9afb9536716d12561b3/Kyhc6muKTs6gtn2hF7t7_w_couple_marshall_lily_kissing_hidden_underpass%20copy.jpg',
];

function pathBasename(pathname: string): string {
  const idx = pathname.lastIndexOf('/');
  return idx === -1 ? pathname : pathname.slice(idx + 1);
}

export function isDefaultPlaceholderUrl(url: string): boolean {
  if (DEFAULT_PHOTO_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return true;
  }
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.get('isDefault') === 'true') return true;
    const basename = pathBasename(parsed.pathname);
    if (STOCK_PHOTO_FILENAME_PATTERNS.some((re) => re.test(basename))) return true;
    const bareUrl = `${parsed.origin}${parsed.pathname}`;
    if (STOCK_PHOTO_URLS.includes(bareUrl)) return true;
  } catch {
    // Not a parseable absolute URL; fall through.
  }
  return false;
}

export function extractSourcePhotoUrl(event: EventByIdResponse): SourcePhoto | null {
  const headerPhoto = event.eventDesign?.activeWebsiteHeaderPresentationLayout?.dataJSON?.photos?.[0];
  if (headerPhoto?.url && !isDefaultPlaceholderUrl(headerPhoto.url)) {
    return { url: headerPhoto.url, source: 'headerLayout' };
  }
  if (
    event.photoV2?.url &&
    event.photoV2.__typename !== 'DefaultPagePhoto' &&
    !isDefaultPlaceholderUrl(event.photoV2.url)
  ) {
    return { url: event.photoV2.url, source: 'photoV2Url' };
  }
  // if (event.photo?.url) return { url: event.photo.url, source: 'photo' };
  if (event.firebasePhotoPath) {
    const url = event.firebasePhotoPath.startsWith('http')
      ? event.firebasePhotoPath
      : `https://withjoy.com/media/${event.id}/${event.firebasePhotoPath}`;
    if (!isDefaultPlaceholderUrl(url)) {
      return { url, source: 'firebasePhotoPath' };
    }
  }
  return null;
}
