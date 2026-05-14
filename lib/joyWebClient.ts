import axios, { AxiosError } from 'axios';

type Headers = { Authorization: string; 'Content-Type': string };

export interface SupportedHeaderPhotoLayoutSchema {
  photos?: ReadonlyArray<{ id: string; url: string }>;
}

export interface EventByIdResponse {
  id: string;
  website?: string | null;
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
        photo { id url }
        photoV2 {
          __typename
          ... on DefaultPagePhoto { url }
          ... on Photo { url }
        }
        firebasePhotoPath
        eventDesign {
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
];

export function isDefaultPlaceholderUrl(url: string): boolean {
  if (DEFAULT_PHOTO_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return true;
  }
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.get('isDefault') === 'true') return true;
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
