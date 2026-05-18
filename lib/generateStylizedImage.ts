import axios from "axios";
import sharp from "sharp";
import { type Content, GoogleGenAI, Modality, type Part } from "@google/genai";

const MARGIN_FRACTION = 0.05;

const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

const ai = new GoogleGenAI({
  vertexai: true,
  project: "project-withjoy",
  location: "global",
  googleAuthOptions: {
    credentials: SERVICE_ACCOUNT_JSON
      ? JSON.parse(SERVICE_ACCOUNT_JSON)
      : undefined,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  },
});

type InlineImage = { mimeType: string; base64: string };

function fileUriPart(url: string): Part {
  let mimeType = `image/${url.split(".").pop()}`;
  if (mimeType === "image/jpg") mimeType = "image/jpeg";
  return { fileData: { mimeType, fileUri: url } };
}

function inlineImagePart(image: InlineImage): Part {
  return { inlineData: { mimeType: image.mimeType, data: image.base64 } };
}

async function fetchImageInline(url: string): Promise<InlineImage> {
  const res = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 60_000,
    maxContentLength: 25 * 1024 * 1024,
    headers: { "User-Agent": "joy-studio-generated-photo-script/1.0" },
  });
  const headerType = (res.headers["content-type"] as string | undefined)
    ?.split(";")[0]
    ?.trim();
  let mimeType =
    headerType && headerType.startsWith("image/") ? headerType : "";
  if (!mimeType) {
    const ext = url.split("?")[0]!.split(".").pop()!.toLowerCase();
    mimeType = `image/${ext === "jpg" ? "jpeg" : ext}`;
  }
  return { mimeType, base64: Buffer.from(res.data).toString("base64") };
}

const styles = {
  doodle: [
    "https://withjoy.blob.core.windows.net/paper-ai/style-doodle-01.png",
    "https://withjoy.blob.core.windows.net/paper-ai/style-doodle-03.jpg",
    "https://withjoy.blob.core.windows.net/paper-ai/style-doodle-04.png",
  ],
  toon: ["https://withjoy.blob.core.windows.net/paper-ai/style-toon-01.jpg"],
  martoon: [
    "https://withjoy.blob.core.windows.net/paper-ai/style-martoon-01.png",
  ],
};

export type StyleID = keyof typeof styles;

export class GenerateStylizedImageError extends Error {}

export async function generateStylizedImage(
  styleId: StyleID,
  subjectUrl: string
): Promise<Buffer> {
  const styleUrls = styles[styleId];
  if (!styleUrls) throw new Error(`Style ${styleId} not found`);

  const subjectInline = await fetchImageInline(subjectUrl);

  const userContent: Content = {
    role: "user",
    parts: [
      {
        text: [
          "Study the style from the first image.",
          "Use that style and draw the people in the second image I provided you.",
          "Preserve the facial expressions and emotions of the people in the second image into the output image.",
          "Preserve the relative position and pose of the people in the second image into the output image.",
          "If someone is on the left of someone else, do not move them to right and vice versa.",
          "Background must be white (#ffffff).",
          "The output artwork should fill the frame (no signficant padding) and artistically transition to white at all four edges.",
          "If the image is upside down, flip it.",
        ].join("\n"),
      },
      ...styleUrls.map(fileUriPart),
      inlineImagePart(subjectInline),
    ],
  };

  const response = await ai.models.generateContent({
    model: "gemini-3.1-flash-image-preview",
    contents: [userContent],
    config: {
      temperature: 0,
      responseModalities: [Modality.IMAGE],
      imageConfig: {
        aspectRatio: "3:4",
        imageSize: "1K",
      },
    },
  });

  const partData =
    response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!partData) {
    const finishReason = response.candidates?.[0]?.finishReason;
    throw new GenerateStylizedImageError(finishReason ?? "UNKNOWN");
  }

  const raw = Buffer.from(partData, "base64");
  const meta = await sharp(raw).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) {
    throw new GenerateStylizedImageError(
      `sharp metadata missing dims: w=${width} h=${height}`
    );
  }
  const horizontalPad = Math.round(width * MARGIN_FRACTION);
  const verticalPad = Math.round(height * MARGIN_FRACTION);
  return sharp(raw)
    .extend({
      top: verticalPad,
      bottom: verticalPad,
      left: horizontalPad,
      right: horizontalPad,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toBuffer();
}
