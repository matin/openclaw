import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  createProviderOperationDeadline,
  executeProviderOperationWithRetry,
  resolveProviderOperationTimeoutMs,
  waitProviderOperationPollInterval,
} from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";
import { parseGeminiAuth, resolveGoogleGenerativeAiApiOrigin } from "./api.js";
import {
  createGoogleVideoGenerationProviderMetadata,
  DEFAULT_GOOGLE_VIDEO_MODEL,
  GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS,
  GOOGLE_VIDEO_MAX_DURATION_SECONDS,
  GOOGLE_VIDEO_MIN_DURATION_SECONDS,
} from "./generation-provider-metadata.js";
import { createGoogleGenAI, type GoogleGenAIClient } from "./google-genai-runtime.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 120;
const DEFAULT_GENERATED_VIDEO_MAX_BYTES = 16 * 1024 * 1024;
const GOOGLE_VIDEO_EMPTY_RESULT_MESSAGE =
  "Google video generation response missing generated videos";
const GOOGLE_VIDEO_MODEL_ALIASES: Record<string, string> = {
  "veo-2": "veo-2.0-generate-001",
  "veo-2.0": "veo-2.0-generate-001",
  "veo-3": "veo-3.1-generate-001",
  "veo-3.1": "veo-3.1-generate-001",
  "veo-3.1-fast": "veo-3.1-fast-generate-001",
  "veo-3.1-generate-preview": "veo-3.1-generate-001",
  "veo-3.1-fast-generate-preview": "veo-3.1-fast-generate-001",
};

async function resolveVertexOAuthToken(): Promise<string> {
  try {
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      {
        headers: { "Metadata-Flavor": "Google" },
      },
    );
    if (res.ok) {
      const data = (await res.json()) as { access_token?: string };
      if (data.access_token) {
        return data.access_token;
      }
    }
  } catch {
    // Metadata-server token unavailable (not on GCE / no default SA); fall
    // through to the ADC path below.
  }
  const { resolveGoogleVertexAuthorizedUserHeaders } = await import("./vertex-adc.js");
  const headers = await resolveGoogleVertexAuthorizedUserHeaders(fetch);
  return headers.Authorization.replace(/^Bearer\s+/i, "");
}

function resolveConfiguredGoogleVideoBaseUrl(req: VideoGenerationRequest): string | undefined {
  const configured = normalizeOptionalString(req.cfg?.models?.providers?.google?.baseUrl);
  return configured ? resolveGoogleGenerativeAiApiOrigin(configured) : undefined;
}

function resolveGeneratedVideoMaxBytes(req: VideoGenerationRequest): number {
  const configured = req.cfg.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * 1024 * 1024);
  }
  return DEFAULT_GENERATED_VIDEO_MAX_BYTES;
}

function assertGeneratedVideoBufferWithinLimit(buffer: Buffer, maxBytes: number): void {
  if (buffer.length > maxBytes) {
    throw new Error(`Google generated video download exceeds ${maxBytes} bytes`);
  }
}

function resolveGoogleVideoRestBaseUrl(configuredBaseUrl?: string): string {
  return `${configuredBaseUrl ?? "https://generativelanguage.googleapis.com"}/v1beta`;
}

function resolveGoogleVideoRestModelPath(model: string): string {
  return `models/${resolveGoogleVideoModel(model)}`;
}

function resolveGoogleVideoModel(model: string | undefined): string {
  const trimmed = normalizeOptionalString(model) || DEFAULT_GOOGLE_VIDEO_MODEL;
  let bare = trimmed;
  if (bare.startsWith("google/models/")) {
    bare = bare.slice("google/models/".length);
  } else if (bare.startsWith("models/")) {
    bare = bare.slice("models/".length);
  } else if (bare.startsWith("google/")) {
    bare = bare.slice("google/".length);
  }
  return GOOGLE_VIDEO_MODEL_ALIASES[bare] ?? bare;
}

function resolveVertexVideoLocation(): string {
  const configured =
    normalizeOptionalString(process.env.GOOGLE_VERTEX_VIDEO_LOCATION) ||
    normalizeOptionalString(process.env.GOOGLE_CLOUD_LOCATION);
  return configured && configured !== "global" ? configured : "us-central1";
}

function parseVideoSize(size: string | undefined): { width: number; height: number } | undefined {
  const trimmed = normalizeOptionalString(size);
  if (!trimmed) {
    return undefined;
  }
  const match = /^(\d+)x(\d+)$/u.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const width = Number.parseInt(match[1] ?? "", 10);
  const height = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return undefined;
  }
  return { width, height };
}

function resolveAspectRatio(params: {
  aspectRatio?: string;
  size?: string;
}): "16:9" | "9:16" | undefined {
  const direct = normalizeOptionalString(params.aspectRatio);
  if (direct === "16:9" || direct === "9:16") {
    return direct;
  }
  const parsedSize = parseVideoSize(params.size);
  if (!parsedSize) {
    return undefined;
  }
  return parsedSize.width >= parsedSize.height ? "16:9" : "9:16";
}

function resolveResolution(params: {
  resolution?: string;
  size?: string;
}): "720p" | "1080p" | undefined {
  if (params.resolution === "720P") {
    return "720p";
  }
  if (params.resolution === "1080P") {
    return "1080p";
  }
  const parsedSize = parseVideoSize(params.size);
  if (!parsedSize) {
    return undefined;
  }
  const maxEdge = Math.max(parsedSize.width, parsedSize.height);
  return maxEdge >= 1920 ? "1080p" : maxEdge >= 1280 ? "720p" : undefined;
}

function resolveDurationSeconds(durationSeconds: number | undefined): number | undefined {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) {
    return undefined;
  }
  const rounded = Math.min(
    GOOGLE_VIDEO_MAX_DURATION_SECONDS,
    Math.max(GOOGLE_VIDEO_MIN_DURATION_SECONDS, Math.round(durationSeconds)),
  );
  return GOOGLE_VIDEO_ALLOWED_DURATION_SECONDS.reduce((best, current) => {
    const currentDistance = Math.abs(current - rounded);
    const bestDistance = Math.abs(best - rounded);
    if (currentDistance < bestDistance) {
      return current;
    }
    if (currentDistance === bestDistance && current > best) {
      return current;
    }
    return best;
  });
}

function resolveInputImage(req: VideoGenerationRequest) {
  const input = req.inputImages?.[0];
  if (!input?.buffer) {
    return undefined;
  }
  return {
    imageBytes: input.buffer.toString("base64"),
    mimeType: normalizeOptionalString(input.mimeType) || "image/png",
  };
}

function resolveInputVideo(req: VideoGenerationRequest) {
  const input = req.inputVideos?.[0];
  if (!input?.buffer) {
    return undefined;
  }
  return {
    videoBytes: input.buffer.toString("base64"),
    mimeType: normalizeOptionalString(input.mimeType) || "video/mp4",
  };
}

function resolveGoogleGeneratedVideoDownloadUrl(params: {
  uri: string | undefined;
  apiKey?: string;
  configuredBaseUrl?: string;
}): string | undefined {
  const trimmed = normalizeOptionalString(params.uri);
  if (!trimmed) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") {
    return undefined;
  }
  const allowedOrigins = new Set(["https://generativelanguage.googleapis.com"]);
  if (params.configuredBaseUrl) {
    try {
      const configuredOrigin = new URL(params.configuredBaseUrl).origin;
      if (configuredOrigin.startsWith("https://")) {
        allowedOrigins.add(configuredOrigin);
      }
    } catch {
      // Ignore invalid configured origins; resolveConfiguredGoogleVideoBaseUrl already normalizes.
    }
  }
  if (!allowedOrigins.has(url.origin)) {
    return undefined;
  }
  if (params.apiKey && !url.searchParams.has("key")) {
    url.searchParams.set("key", params.apiKey);
  }
  return url.toString();
}

function resolveGoogleGeneratedVideoFileDownloadUrl(params: {
  file: unknown;
  apiKey?: string;
  configuredBaseUrl?: string;
}): string | undefined {
  const resource = params.file as { name?: unknown; uri?: unknown } | undefined;
  const name = normalizeOptionalString(resource?.name) ?? normalizeOptionalString(resource?.uri);
  if (!name || !/^files\/[^/?#]+$/u.test(name)) {
    return undefined;
  }
  const baseUrl = resolveGoogleVideoRestBaseUrl(params.configuredBaseUrl);
  const url = new URL(`${baseUrl}/${name}:download`);
  url.searchParams.set("alt", "media");
  if (params.apiKey) {
    url.searchParams.set("key", params.apiKey);
  }
  return url.toString();
}

async function downloadGeneratedVideoFromUri(params: {
  uri: string | undefined;
  apiKey?: string;
  configuredBaseUrl?: string;
  mimeType?: string;
  index: number;
  maxBytes: number;
  timeoutMs: number;
}): Promise<GeneratedVideoAsset | undefined> {
  const downloadUrl = resolveGoogleGeneratedVideoDownloadUrl({
    uri: params.uri,
    apiKey: params.apiKey,
    configuredBaseUrl: params.configuredBaseUrl,
  });
  if (!downloadUrl) {
    return undefined;
  }
  return await executeProviderOperationWithRetry({
    provider: "google",
    stage: "download",
    operation: async () => {
      const { response, release } = await fetchWithSsrFGuard({
        url: downloadUrl,
        timeoutMs: params.timeoutMs,
      });
      try {
        if (!response.ok) {
          throw new Error(
            `Failed to download Google generated video: ${response.status} ${response.statusText}`,
          );
        }
        const buffer = await readResponseWithLimit(response, params.maxBytes, {
          chunkTimeoutMs: params.timeoutMs,
          onOverflow: ({ maxBytes }) =>
            new Error(`Google generated video download exceeds ${maxBytes} bytes`),
          onIdleTimeout: ({ chunkTimeoutMs }) =>
            new Error(`Google generated video download stalled after ${chunkTimeoutMs}ms`),
        });
        return {
          buffer,
          mimeType:
            normalizeOptionalString(response.headers.get("content-type")) ||
            normalizeOptionalString(params.mimeType) ||
            "video/mp4",
          fileName: `video-${params.index + 1}.mp4`,
        };
      } finally {
        await release();
      }
    },
  });
}

function extractGoogleApiErrorCode(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | undefined)?.status;
  if (typeof status === "number") {
    return status;
  }
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message) as { code?: unknown; error?: { code?: unknown } };
    const code = typeof parsed.code === "number" ? parsed.code : parsed.error?.code;
    return typeof code === "number" ? code : undefined;
  } catch {
    return /\b404\b/u.test(message) ? 404 : undefined;
  }
}

function extractGeneratedVideos(operation: unknown): Array<{ video?: unknown }> {
  const response = (operation as { response?: Record<string, unknown> }).response;
  const videos = response?.videos;
  if (Array.isArray(videos) && videos.length > 0) {
    return videos.map((video) => ({ video }));
  }
  const generatedVideos = response?.generatedVideos;
  if (Array.isArray(generatedVideos) && generatedVideos.length > 0) {
    return generatedVideos as Array<{ video?: unknown }>;
  }
  const generatedSamples = (response?.generateVideoResponse as { generatedSamples?: unknown })
    ?.generatedSamples;
  return Array.isArray(generatedSamples) ? (generatedSamples as Array<{ video?: unknown }>) : [];
}

async function requestGoogleVideoJson(params: {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  deadline: ReturnType<typeof createProviderOperationDeadline>;
  stage: "create" | "poll";
  body?: unknown;
}): Promise<unknown> {
  function createHttpError(response: Response, detail: unknown): Error {
    const parts = [`HTTP ${response.status}`];
    const statusText = response.statusText.trim();
    if (statusText) {
      parts.push(statusText);
    }
    if (typeof detail === "string") {
      const trimmed = detail.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
    } else if (detail && typeof detail === "object") {
      parts.push(JSON.stringify(detail));
    }
    const error = new Error(parts.join(": "));
    Object.assign(error, { status: response.status, statusCode: response.status });
    return error;
  }

  return await executeProviderOperationWithRetry({
    provider: "google",
    stage: params.stage,
    operation: async () => {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => {
          const error = new Error("request timed out");
          error.name = "TimeoutError";
          controller.abort(error);
        },
        resolveProviderOperationTimeoutMs({
          deadline: params.deadline,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      );
      try {
        const { response, release } = await fetchWithSsrFGuard({
          url: params.url,
          init: {
            method: params.method,
            headers: params.headers,
            ...(params.body === undefined ? {} : { body: JSON.stringify(params.body) }),
          },
          signal: controller.signal,
        });
        try {
          const text = await response.text();
          if (!response.ok) {
            let detail: unknown = text;
            if (text) {
              try {
                detail = JSON.parse(text) as unknown;
              } catch {
                detail = text;
              }
            }
            throw createHttpError(response, detail);
          }
          const payload = text ? (JSON.parse(text) as unknown) : {};
          return payload;
        } finally {
          await release();
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

async function generateGoogleVideoViaRest(params: {
  baseUrl: string;
  headers: Record<string, string>;
  deadline: ReturnType<typeof createProviderOperationDeadline>;
  model: string;
  prompt: string;
  durationSeconds?: number;
  aspectRatio?: "16:9" | "9:16";
  resolution?: "720p" | "1080p";
  image?: { imageBytes: string; mimeType: string };
  video?: { videoBytes: string; mimeType: string };
  pollStyle?: "getOperation" | "fetchPredictOperation";
}): Promise<unknown> {
  let operation = await requestGoogleVideoJson({
    url: `${params.baseUrl}/${resolveGoogleVideoRestModelPath(params.model)}:predictLongRunning`,
    method: "POST",
    headers: params.headers,
    deadline: params.deadline,
    stage: "create",
    body: {
      instances: [
        {
          prompt: params.prompt,
          ...(params.image
            ? {
                image: {
                  bytesBase64Encoded: params.image.imageBytes,
                  mimeType: params.image.mimeType,
                },
              }
            : {}),
          ...(params.video
            ? {
                video: {
                  bytesBase64Encoded: params.video.videoBytes,
                  mimeType: params.video.mimeType,
                },
              }
            : {}),
        },
      ],
      parameters: {
        ...(typeof params.durationSeconds === "number"
          ? { durationSeconds: params.durationSeconds }
          : {}),
        ...(params.aspectRatio ? { aspectRatio: params.aspectRatio } : {}),
        ...(params.resolution ? { resolution: params.resolution } : {}),
      },
    },
  });

  for (let attempt = 0; !((operation as { done?: boolean }).done ?? false); attempt += 1) {
    if (attempt >= MAX_POLL_ATTEMPTS) {
      throw new Error("Google video generation did not finish in time");
    }
    await waitProviderOperationPollInterval({
      deadline: params.deadline,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    const operationName = (operation as { name?: unknown }).name;
    if (typeof operationName !== "string" || !operationName) {
      throw new Error("Google video operation response missing name for polling");
    }
    if (params.pollStyle === "fetchPredictOperation") {
      operation = await requestGoogleVideoJson({
        url: `${params.baseUrl}/${resolveGoogleVideoRestModelPath(params.model)}:fetchPredictOperation`,
        method: "POST",
        headers: params.headers,
        deadline: params.deadline,
        stage: "poll",
        body: { operationName },
      });
      continue;
    }
    let pollUrl = `${params.baseUrl}/${operationName}`;
    if (operationName.startsWith("projects/")) {
      const originMatch = params.baseUrl.match(/^(https:\/\/[^/]+)/u);
      if (originMatch?.[1]) {
        pollUrl = `${originMatch[1]}/v1beta1/${operationName}`;
      }
    }
    operation = await requestGoogleVideoJson({
      url: pollUrl,
      method: "GET",
      headers: params.headers,
      deadline: params.deadline,
      stage: "poll",
    });
  }
  const error = (operation as { error?: unknown }).error;
  if (error) {
    throw new Error(JSON.stringify(error));
  }
  return operation;
}

export function buildGoogleVideoGenerationProvider(): VideoGenerationProvider {
  return {
    ...createGoogleVideoGenerationProviderMetadata(),
    async generateVideo(req) {
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("Google video generation supports at most one input image.");
      }
      if ((req.inputVideos?.length ?? 0) > 1) {
        throw new Error("Google video generation supports at most one input video.");
      }
      if ((req.inputImages?.length ?? 0) > 0 && (req.inputVideos?.length ?? 0) > 0) {
        throw new Error(
          "Google video generation does not support image and video inputs together.",
        );
      }
      const auth = await resolveApiKeyForProvider({
        provider: "google",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });

      const isVertex =
        process.env.GOOGLE_GENAI_USE_VERTEXAI === "true" ||
        auth.apiKey === "gcp-vertex-credentials";

      if (!isVertex && !auth.apiKey) {
        throw new Error("Google API key missing");
      }

      const apiKey = auth.apiKey;
      const durationSeconds = resolveDurationSeconds(req.durationSeconds);
      const model = resolveGoogleVideoModel(req.model);
      const aspectRatio = resolveAspectRatio({ aspectRatio: req.aspectRatio, size: req.size });
      const resolution =
        resolveResolution({ resolution: req.resolution, size: req.size }) ??
        // Default unspecified requests to 1080p. Veo 3.x only supports 1080p at
        // 16:9, so leave portrait (9:16) at the Veo default (720p).
        (aspectRatio === "9:16" ? undefined : "1080p");
      const hasReferenceInputs =
        (req.inputImages?.length ?? 0) > 0 || (req.inputVideos?.length ?? 0) > 0;
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "Google video generation",
      });

      let restBaseUrl: string;
      let authHeaders: Record<string, string>;
      let client: GoogleGenAIClient | undefined;
      let configuredBaseUrl: string | undefined;
      let restPollStyle: "getOperation" | "fetchPredictOperation" = "getOperation";

      if (isVertex) {
        const token = await resolveVertexOAuthToken();
        const project = process.env.GOOGLE_CLOUD_PROJECT || "casita-mb";
        const location = resolveVertexVideoLocation();
        restBaseUrl = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google`;
        authHeaders = { Authorization: `Bearer ${token}` };
        restPollStyle = "fetchPredictOperation";
      } else {
        configuredBaseUrl = resolveConfiguredGoogleVideoBaseUrl(req);
        restBaseUrl = resolveGoogleVideoRestBaseUrl(configuredBaseUrl);
        authHeaders = parseGeminiAuth(apiKey!).headers;
        client = createGoogleGenAI({
          apiKey: apiKey!,
          httpOptions: {
            ...(configuredBaseUrl ? { baseUrl: configuredBaseUrl } : {}),
            timeout: resolveProviderOperationTimeoutMs({
              deadline,
              defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
            }),
          },
        });
      }

      let usedRestFallback = false;
      let operation;
      try {
        if (!client) {
          throw new Error("Force rest fallback for Vertex");
        }
        operation = await client.models.generateVideos({
          model,
          prompt: req.prompt,
          image: resolveInputImage(req),
          video: resolveInputVideo(req),
          config: {
            ...(typeof durationSeconds === "number" ? { durationSeconds } : {}),
            ...(aspectRatio ? { aspectRatio } : {}),
            ...(resolution ? { resolution } : {}),
          },
        });
      } catch (error) {
        if (!isVertex && (hasReferenceInputs || extractGoogleApiErrorCode(error) !== 404)) {
          throw error;
        }
        usedRestFallback = true;
        operation = await generateGoogleVideoViaRest({
          baseUrl: restBaseUrl,
          headers: authHeaders,
          deadline,
          model,
          prompt: req.prompt,
          durationSeconds,
          aspectRatio,
          resolution,
          image: resolveInputImage(req),
          video: resolveInputVideo(req),
          pollStyle: restPollStyle,
        });
      }

      if (!usedRestFallback) {
        if (!client) {
          throw new Error("Google video SDK client missing for SDK operation polling");
        }
        const sdkClient = client;
        let sdkOperation = operation as Awaited<
          ReturnType<GoogleGenAIClient["models"]["generateVideos"]>
        >;
        for (let attempt = 0; !(sdkOperation.done ?? false); attempt += 1) {
          if (attempt >= MAX_POLL_ATTEMPTS) {
            throw new Error("Google video generation did not finish in time");
          }
          await waitProviderOperationPollInterval({ deadline, pollIntervalMs: POLL_INTERVAL_MS });
          resolveProviderOperationTimeoutMs({ deadline, defaultTimeoutMs: DEFAULT_TIMEOUT_MS });
          sdkOperation = await executeProviderOperationWithRetry({
            provider: "google",
            stage: "poll",
            operation: () => sdkClient.operations.getVideosOperation({ operation: sdkOperation }),
          });
        }
        operation = sdkOperation;
      }
      const finalOperation = operation as { error?: unknown; name?: string };
      if (finalOperation.error) {
        throw new Error(JSON.stringify(finalOperation.error));
      }
      let generatedVideos = extractGeneratedVideos(operation);
      if (generatedVideos.length === 0 && !hasReferenceInputs && !usedRestFallback) {
        operation = await generateGoogleVideoViaRest({
          baseUrl: restBaseUrl,
          headers: authHeaders,
          deadline,
          model,
          prompt: req.prompt,
          durationSeconds,
          aspectRatio,
          resolution,
          image: resolveInputImage(req),
          video: resolveInputVideo(req),
          pollStyle: restPollStyle,
        });
        generatedVideos = extractGeneratedVideos(operation);
      }
      if (generatedVideos.length === 0) {
        throw new Error(GOOGLE_VIDEO_EMPTY_RESULT_MESSAGE);
      }
      const maxVideoBytes = resolveGeneratedVideoMaxBytes(req);
      const videos = await Promise.all(
        generatedVideos.map(async (entry, index) => {
          const inline = entry.video as
            | {
                videoBytes?: string;
                bytesBase64Encoded?: string;
                uri?: string;
                gcsUri?: string;
                mimeType?: string;
              }
            | undefined;
          const videoBytes =
            normalizeOptionalString(inline?.videoBytes) ||
            normalizeOptionalString(inline?.bytesBase64Encoded);
          if (videoBytes) {
            const buffer = Buffer.from(videoBytes, "base64");
            assertGeneratedVideoBufferWithinLimit(buffer, maxVideoBytes);
            return {
              buffer,
              mimeType: normalizeOptionalString(inline?.mimeType) || "video/mp4",
              fileName: `video-${index + 1}.mp4`,
            };
          }
          const directDownload = await downloadGeneratedVideoFromUri({
            uri: normalizeOptionalString(inline?.uri) || normalizeOptionalString(inline?.gcsUri),
            apiKey,
            configuredBaseUrl,
            mimeType: inline?.mimeType,
            index,
            maxBytes: maxVideoBytes,
            timeoutMs: resolveProviderOperationTimeoutMs({
              deadline,
              defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
            }),
          });
          if (directDownload) {
            return directDownload;
          }
          if (!inline) {
            throw new Error("Google generated video missing file handle");
          }
          const fileDownload = await downloadGeneratedVideoFromUri({
            uri: resolveGoogleGeneratedVideoFileDownloadUrl({
              file: inline,
              apiKey,
              configuredBaseUrl,
            }),
            apiKey,
            configuredBaseUrl,
            mimeType: inline.mimeType,
            index,
            maxBytes: maxVideoBytes,
            timeoutMs: resolveProviderOperationTimeoutMs({
              deadline,
              defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
            }),
          });
          if (!fileDownload) {
            throw new Error("Google generated video missing bounded download URL");
          }
          return fileDownload;
        }),
      );
      return {
        videos,
        model,
        metadata: finalOperation.name
          ? {
              operationName: finalOperation.name,
            }
          : undefined,
      };
    },
  };
}
