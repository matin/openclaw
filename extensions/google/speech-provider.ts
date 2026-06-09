import { transcodeAudioBufferToOpus } from "openclaw/plugin-sdk/media-runtime";
import {
  assertOkOrThrowProviderError,
  postJsonRequest,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech-core";
import { asObject, trimToUndefined } from "openclaw/plugin-sdk/speech-core";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveGoogleGenerativeAiHttpRequestConfig } from "./api.js";
import {
  hasGoogleVertexAuthorizedUserAdcSync,
  isGoogleVertexCredentialsMarker,
  resolveGoogleVertexAuthorizedUserHeaders,
} from "./vertex-adc.js";

const DEFAULT_GOOGLE_TTS_MODEL = "gemini-3.1-flash-tts-preview";
const DEFAULT_GOOGLE_TTS_VOICE = "Kore";
// The BCP-47 locale the auto-detector emits when it is confident the text is
// Spanish (issue #251). Team/principal locale; an operator can pin a different
// locale via `languageCode` or a `[[tts:language=...]]` directive.
const DEFAULT_GOOGLE_TTS_DETECTED_SPANISH_LANGUAGE = "es-MX";
const GOOGLE_TTS_SAMPLE_RATE = 24_000;
const GOOGLE_TTS_CHANNELS = 1;
const GOOGLE_TTS_BITS_PER_SAMPLE = 16;
const GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE = "audio-profile-v1";

const GOOGLE_TTS_MODELS = [
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro-preview-tts",
] as const;

const GOOGLE_TTS_VOICES = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
] as const;

type GoogleTtsProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  voiceName: string;
  languageCode?: string;
  detectLanguage?: boolean;
  audioProfile?: string;
  speakerName?: string;
  promptTemplate?: typeof GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE;
  personaPrompt?: string;
};

type GoogleTtsProviderOverrides = {
  model?: string;
  voiceName?: string;
  languageCode?: string;
  audioProfile?: string;
  speakerName?: string;
};

type Maybe<T> = T | undefined;

type GoogleInlineDataPart = {
  mimeType?: string;
  mime_type?: string;
  data?: string;
};

type GoogleGenerateSpeechResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: GoogleInlineDataPart;
        inline_data?: GoogleInlineDataPart;
      }>;
    };
  }>;
};

class GoogleTtsRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleTtsRetryableError";
  }
}

function isGoogleTtsRetryableError(err: unknown): boolean {
  if (err instanceof GoogleTtsRetryableError) {
    return true;
  }
  if (!(err instanceof Error)) {
    return false;
  }
  if (err.name === "AbortError") {
    return true;
  }
  const message = err.message.toLowerCase();
  return (
    message.includes("aborted") ||
    message.includes("timeout") ||
    message.includes("fetch failed") ||
    message.includes("network")
  );
}

function normalizeGoogleTtsModel(model: unknown): string {
  const trimmed = normalizeOptionalString(model);
  if (!trimmed) {
    return DEFAULT_GOOGLE_TTS_MODEL;
  }
  const withoutProvider = trimmed.startsWith("google/") ? trimmed.slice("google/".length) : trimmed;
  return withoutProvider === "gemini-3.1-flash-tts" ? DEFAULT_GOOGLE_TTS_MODEL : withoutProvider;
}

function normalizeGoogleTtsVoiceName(voiceName: unknown): string {
  return normalizeOptionalString(voiceName) ?? DEFAULT_GOOGLE_TTS_VOICE;
}

/**
 * Gemini's `speechConfig.languageCode` takes BCP-47 locales (e.g. `es-MX`),
 * unlike the SDK's `normalizeLanguageCode` which only accepts bare ISO 639-1.
 * Validate the BCP-47 shape and canonicalize casing (language lowercase, region
 * uppercase). Returns undefined for an absent value; throws on a malformed one.
 */
function normalizeGoogleTtsLanguageCode(value: unknown): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(trimmed)) {
    throw new Error(
      `Invalid Google TTS languageCode: ${trimmed} (expected a BCP-47 code, e.g. es-MX)`,
    );
  }
  const [language, ...subtags] = trimmed.split("-");
  const canonicalSubtags = subtags.map((part) => (part.length === 2 ? part.toUpperCase() : part));
  return [language.toLowerCase(), ...canonicalSubtags].join("-");
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
}

function normalizeGooglePromptTemplate(
  value: unknown,
): typeof GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE) {
    return trimmed;
  }
  throw new Error(`Invalid Google TTS promptTemplate: ${trimmed}`);
}

function resolveGoogleTtsEnvApiKey(): string | undefined {
  return (
    normalizeOptionalString(process.env.GEMINI_API_KEY) ??
    normalizeOptionalString(process.env.GOOGLE_API_KEY)
  );
}

function resolveGoogleTtsModelProviderApiKey(cfg?: OpenClawConfig): string | undefined {
  return normalizeResolvedSecretInputString({
    value: cfg?.models?.providers?.google?.apiKey,
    path: "models.providers.google.apiKey",
  });
}

function resolveGoogleTtsApiKey(params: {
  cfg?: OpenClawConfig;
  providerConfig: SpeechProviderConfig;
}): string | undefined {
  return (
    readGoogleTtsProviderConfig(params.providerConfig).apiKey ??
    resolveGoogleTtsModelProviderApiKey(params.cfg) ??
    resolveGoogleTtsEnvApiKey()
  );
}

function resolveGoogleTtsBaseUrl(params: {
  cfg?: OpenClawConfig;
  providerConfig: GoogleTtsProviderConfig;
}): string | undefined {
  return (
    params.providerConfig.baseUrl ?? trimToUndefined(params.cfg?.models?.providers?.google?.baseUrl)
  );
}

function resolveGoogleTtsConfigRecord(
  rawConfig: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const providers = asObject(rawConfig.providers);
  return asObject(providers?.google) ?? asObject(rawConfig.google);
}

function normalizeGoogleTtsProviderConfig(
  rawConfig: Record<string, unknown>,
): GoogleTtsProviderConfig {
  const raw = resolveGoogleTtsConfigRecord(rawConfig);
  const promptTemplate = normalizeGooglePromptTemplate(raw?.promptTemplate);
  const personaPrompt = trimToUndefined(raw?.personaPrompt);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "messages.tts.providers.google.apiKey",
    }),
    baseUrl: trimToUndefined(raw?.baseUrl),
    model: normalizeGoogleTtsModel(raw?.model),
    voiceName: normalizeGoogleTtsVoiceName(raw?.voiceName ?? raw?.voice),
    languageCode: normalizeGoogleTtsLanguageCode(raw?.languageCode ?? raw?.language),
    detectLanguage: asOptionalBoolean(raw?.detectLanguage),
    audioProfile: trimToUndefined(raw?.audioProfile),
    speakerName: trimToUndefined(raw?.speakerName),
    ...(promptTemplate ? { promptTemplate } : {}),
    ...(personaPrompt ? { personaPrompt } : {}),
  };
}

function readGoogleTtsProviderConfig(config: SpeechProviderConfig): GoogleTtsProviderConfig {
  const normalized = normalizeGoogleTtsProviderConfig({});
  const promptTemplate =
    normalizeGooglePromptTemplate(config.promptTemplate) ?? normalized.promptTemplate;
  const personaPrompt = trimToUndefined(config.personaPrompt) ?? normalized.personaPrompt;
  return {
    apiKey: trimToUndefined(config.apiKey) ?? normalized.apiKey,
    baseUrl: trimToUndefined(config.baseUrl) ?? normalized.baseUrl,
    model: normalizeGoogleTtsModel(config.model ?? normalized.model),
    voiceName: normalizeGoogleTtsVoiceName(
      config.voiceName ?? config.voice ?? normalized.voiceName,
    ),
    languageCode:
      normalizeGoogleTtsLanguageCode(config.languageCode ?? config.language) ??
      normalized.languageCode,
    detectLanguage: asOptionalBoolean(config.detectLanguage) ?? normalized.detectLanguage,
    audioProfile: trimToUndefined(config.audioProfile) ?? normalized.audioProfile,
    speakerName: trimToUndefined(config.speakerName) ?? normalized.speakerName,
    ...(promptTemplate ? { promptTemplate } : {}),
    ...(personaPrompt ? { personaPrompt } : {}),
  };
}

function readGoogleTtsOverrides(
  overrides: Maybe<SpeechProviderOverrides>,
): GoogleTtsProviderOverrides {
  if (!overrides) {
    return {};
  }
  return {
    model: normalizeOptionalString(overrides.model),
    voiceName: normalizeOptionalString(overrides.voiceName ?? overrides.voice),
    languageCode: normalizeGoogleTtsLanguageCode(overrides.languageCode ?? overrides.language),
    audioProfile: normalizeOptionalString(overrides.audioProfile),
    speakerName: normalizeOptionalString(overrides.speakerName),
  };
}

function composeGoogleTtsText(params: {
  text: string;
  audioProfile?: string;
  speakerName?: string;
}): string {
  return [
    trimToUndefined(params.audioProfile),
    trimToUndefined(params.speakerName) ? `Speaker name: ${params.speakerName}` : undefined,
    params.text,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext): {
  handled: boolean;
  overrides?: SpeechProviderOverrides;
  warnings?: string[];
} {
  switch (ctx.key) {
    case "voicename":
    case "voice_name":
    case "google_voice":
    case "googlevoice":
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      return { handled: true, overrides: { voiceName: ctx.value } };
    case "google_model":
    case "googlemodel":
      if (!ctx.policy.allowModelId) {
        return { handled: true };
      }
      return { handled: true, overrides: { model: ctx.value } };
    case "language":
    case "languagecode":
    case "language_code":
    case "google_language":
      if (!ctx.policy.allowNormalization) {
        return { handled: true };
      }
      return {
        handled: true,
        overrides: {
          ...ctx.currentOverrides,
          languageCode: normalizeGoogleTtsLanguageCode(ctx.value),
        },
      };
    default:
      return { handled: false };
  }
}

// --- Spanish auto-detection (issue #251) ------------------------------------
//
// Without speechConfig.languageCode, Gemini TTS infers the spoken language from
// the text's *script*: Arabic script -> Persian (correct for Farsi), but Latin
// script defaults to English, so Latin-script Spanish is read with an English
// accent. The detector closes that gap for the one ambiguous Latin-script case
// we hit in practice (Spanish vs English) and abstains on everything else, so
// non-Latin scripts keep their correct script-based auto-selection and English
// stays English. It emits a locale only when confident — abstain-on-ambiguity.

const GOOGLE_TTS_SPANISH_STOPWORDS = new Set([
  "el",
  "la",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
  "de",
  "del",
  "que",
  "qué",
  "y",
  "en",
  "con",
  "sin",
  "por",
  "para",
  "su",
  "sus",
  "lo",
  "le",
  "les",
  "se",
  "es",
  "está",
  "están",
  "estoy",
  "soy",
  "muy",
  "más",
  "pero",
  "como",
  "cómo",
  "porque",
  "cuando",
  "donde",
  "dónde",
  "hola",
  "gracias",
  "días",
  "buenos",
  "buenas",
  "ahora",
  "aquí",
  "vamos",
  "vámonos",
  "hoy",
  "mañana",
  "también",
  "tú",
  "yo",
  "él",
  "ella",
  "nosotros",
  "ustedes",
]);

const GOOGLE_TTS_ENGLISH_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "and",
  "or",
  "in",
  "on",
  "with",
  "without",
  "for",
  "is",
  "are",
  "am",
  "was",
  "were",
  "be",
  "been",
  "being",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "you",
  "your",
  "i",
  "he",
  "she",
  "we",
  "they",
  "but",
  "because",
  "when",
  "where",
  "how",
  "now",
  "here",
  "there",
  "today",
  "tomorrow",
  "hello",
  "thanks",
  "very",
  "more",
  "also",
]);

// True when the text contains any non-Latin-script letter. Such scripts already
// get correct script-based auto-selection from Gemini (Farsi's Arabic script ->
// Persian), so the detector must abstain and never override them. Latin accents
// (ñ, á, ü, ...) are Latin script and do not trip this.
function hasGoogleTtsNonLatinLetter(text: string): boolean {
  for (const char of text) {
    if (/\p{L}/u.test(char) && !/\p{Script=Latin}/u.test(char)) {
      return true;
    }
  }
  return false;
}

/** Strip the audio-profile-v1 wrapper to its transcript so detection scores the
 * reply, not the English prompt scaffolding. Returns the text unchanged when it
 * is not a wrapped prompt. */
function extractGoogleTtsTranscript(text: string): string {
  if (!isOpenClawGoogleAudioProfilePrompt(text)) {
    return text;
  }
  const marker = "### TRANSCRIPT\n";
  const index = text.lastIndexOf(marker);
  return index >= 0 ? text.slice(index + marker.length) : text;
}

function detectGoogleTtsLanguageCode(
  rawText: string,
  spanishLanguageCode: string = DEFAULT_GOOGLE_TTS_DETECTED_SPANISH_LANGUAGE,
): string | undefined {
  const text = extractGoogleTtsTranscript(rawText);
  if (hasGoogleTtsNonLatinLetter(text)) {
    return undefined;
  }
  // Inverted marks are unambiguous Spanish — English never uses them.
  if (/[¿¡]/.test(text)) {
    return spanishLanguageCode;
  }
  const tokens = text.toLowerCase().match(/[\p{Script=Latin}]+/gu) ?? [];
  let spanish = 0;
  let english = 0;
  for (const token of tokens) {
    if (GOOGLE_TTS_SPANISH_STOPWORDS.has(token)) {
      spanish += 1;
    } else if (GOOGLE_TTS_ENGLISH_STOPWORDS.has(token)) {
      english += 1;
    }
  }
  const spanishLetters = /[ñáéíóúü]/i.test(text);
  const confident =
    (spanish >= 2 && spanish > english) || (spanish >= 1 && spanish > english && spanishLetters);
  return confident ? spanishLanguageCode : undefined;
}

/** The `generateContent` request body shared by the AI-Studio and Vertex ADC routes. */
function buildGoogleSpeechGenerateContentBody(params: {
  text: string;
  voiceName: string;
  languageCode?: string;
  audioProfile?: string;
  speakerName?: string;
}): Record<string, unknown> {
  return {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: composeGoogleTtsText({
              text: params.text,
              audioProfile: params.audioProfile,
              speakerName: params.speakerName,
            }),
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        // Omit-when-absent: no languageCode preserves Gemini's script-based
        // auto-selection (the Arabic-script -> Persian path Farsi relies on).
        ...(params.languageCode ? { languageCode: params.languageCode } : {}),
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: params.voiceName,
          },
        },
      },
    },
  };
}

function extractGoogleSpeechPcm(payload: GoogleGenerateSpeechResponse): Buffer {
  for (const candidate of payload.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const inline = part.inlineData ?? part.inline_data;
      const data = normalizeOptionalString(inline?.data);
      if (!data) {
        continue;
      }
      return Buffer.from(data, "base64");
    }
  }
  throw new Error("Google TTS response missing audio data");
}

function normalizePromptSectionText(value: string | undefined): string | undefined {
  const trimmed = trimToUndefined(value?.replace(/\r\n?/g, "\n"));
  if (!trimmed) {
    return undefined;
  }
  let sanitized = "";
  for (const char of trimmed) {
    const code = char.charCodeAt(0);
    if (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    ) {
      continue;
    }
    sanitized += char;
  }
  return sanitized;
}

function normalizePromptList(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => normalizePromptSectionText(value))
    .filter((value): value is string => Boolean(value));
}

function isOpenClawGoogleAudioProfilePrompt(text: string): boolean {
  return (
    text.includes("# AUDIO PROFILE:") &&
    text.includes("### TRANSCRIPT") &&
    text.startsWith("Synthesize speech from the TRANSCRIPT section only.")
  );
}

function renderGoogleAudioProfilePrompt(params: {
  text: string;
  persona?: {
    id: string;
    label?: string;
    prompt?: {
      profile?: string;
      scene?: string;
      sampleContext?: string;
      style?: string;
      accent?: string;
      pacing?: string;
      constraints?: string[];
    };
  };
  personaPrompt?: string;
}): string {
  const transcript = params.text.replace(/\r\n?/g, "\n").trim();
  const prompt = params.persona?.prompt;
  const profile = normalizePromptSectionText(prompt?.profile);
  const scene = normalizePromptSectionText(prompt?.scene);
  const sampleContext = normalizePromptSectionText(prompt?.sampleContext);
  const style = normalizePromptSectionText(prompt?.style);
  const accent = normalizePromptSectionText(prompt?.accent);
  const pacing = normalizePromptSectionText(prompt?.pacing);
  const constraints = normalizePromptList(prompt?.constraints);
  const personaPrompt = normalizePromptSectionText(params.personaPrompt);
  const label =
    normalizePromptSectionText(params.persona?.label) ??
    normalizePromptSectionText(params.persona?.id);

  const sections = [
    [
      "Synthesize speech from the TRANSCRIPT section only. Use the other sections only",
      "as performance direction. Do not read section titles, notes, labels, or",
      "configuration aloud.",
    ].join("\n"),
  ];

  if (label || profile) {
    sections.push([`# AUDIO PROFILE: ${label ?? "voice"}`, profile].filter(Boolean).join("\n"));
  }
  if (scene) {
    sections.push(["## THE SCENE", scene].join("\n"));
  }

  const directorNotes: string[] = [];
  if (style) {
    directorNotes.push(`Style: ${style}`);
  }
  if (accent) {
    directorNotes.push(`Accent: ${accent}`);
  }
  if (pacing) {
    directorNotes.push(`Pacing: ${pacing}`);
  }
  if (constraints.length > 0) {
    directorNotes.push(["Constraints:", ...constraints.map((item) => `- ${item}`)].join("\n"));
  }
  if (personaPrompt) {
    directorNotes.push(["Provider notes:", personaPrompt].join("\n"));
  }
  if (directorNotes.length > 0) {
    sections.push(["### DIRECTOR'S NOTES", ...directorNotes].join("\n"));
  }

  if (sampleContext) {
    sections.push(["### SAMPLE CONTEXT", sampleContext].join("\n"));
  }

  sections.push(["### TRANSCRIPT", transcript].join("\n"));
  return sections.join("\n\n");
}

function wrapPcm16MonoToWav(pcm: Buffer, sampleRate = GOOGLE_TTS_SAMPLE_RATE): Buffer {
  const byteRate = sampleRate * GOOGLE_TTS_CHANNELS * (GOOGLE_TTS_BITS_PER_SAMPLE / 8);
  const blockAlign = GOOGLE_TTS_CHANNELS * (GOOGLE_TTS_BITS_PER_SAMPLE / 8);
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(GOOGLE_TTS_CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(GOOGLE_TTS_BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

async function synthesizeGoogleTtsPcmOnce(params: {
  text: string;
  apiKey: string;
  baseUrl?: string;
  request?: ReturnType<typeof sanitizeConfiguredModelProviderRequest>;
  model: string;
  voiceName: string;
  languageCode?: string;
  audioProfile?: string;
  speakerName?: string;
  timeoutMs: number;
}): Promise<Buffer> {
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveGoogleGenerativeAiHttpRequestConfig({
      apiKey: params.apiKey,
      baseUrl: params.baseUrl,
      request: params.request,
      capability: "audio",
      transport: "http",
    });

  const { response: res, release } = await postJsonRequest({
    url: `${baseUrl}/models/${params.model}:generateContent`,
    headers,
    body: buildGoogleSpeechGenerateContentBody({
      text: params.text,
      voiceName: params.voiceName,
      languageCode: params.languageCode,
      audioProfile: params.audioProfile,
      speakerName: params.speakerName,
    }),
    timeoutMs: params.timeoutMs,
    fetchFn: fetch,
    pinDns: false,
    allowPrivateNetwork,
    dispatcherPolicy,
  });

  try {
    if (!res.ok) {
      try {
        await assertOkOrThrowProviderError(res, "Google TTS failed");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (res.status >= 500 && res.status < 600) {
          throw new GoogleTtsRetryableError(message);
        }
        throw err;
      }
    }
    try {
      return extractGoogleSpeechPcm((await res.json()) as GoogleGenerateSpeechResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new GoogleTtsRetryableError(message);
    }
  } finally {
    await release();
  }
}

async function synthesizeGoogleTtsPcm(params: {
  text: string;
  apiKey: string;
  baseUrl?: string;
  request?: ReturnType<typeof sanitizeConfiguredModelProviderRequest>;
  model: string;
  voiceName: string;
  languageCode?: string;
  audioProfile?: string;
  speakerName?: string;
  timeoutMs: number;
}): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await synthesizeGoogleTtsPcmOnce(params);
    } catch (err) {
      lastError = err;
      if (!isGoogleTtsRetryableError(err) || attempt > 0) {
        throw err;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// Vertex generateContent is served under the v1 API on the aiplatform host.
const GOOGLE_VERTEX_TTS_API_VERSION = "v1";

function resolveGoogleVertexTtsProject(): string {
  const project =
    normalizeOptionalString(process.env.GOOGLE_CLOUD_PROJECT) ??
    normalizeOptionalString(process.env.GCLOUD_PROJECT);
  if (!project) {
    throw new Error(
      "Google Vertex TTS requires a project. Set GOOGLE_CLOUD_PROJECT or GCLOUD_PROJECT.",
    );
  }
  return project;
}

function resolveGoogleVertexTtsLocation(): string {
  // TTS preview models are served from the global endpoint; honor an explicit
  // GOOGLE_CLOUD_LOCATION override but default to global rather than a region.
  return normalizeOptionalString(process.env.GOOGLE_CLOUD_LOCATION) ?? "global";
}

function buildGoogleVertexTtsUrl(params: {
  model: string;
  project: string;
  location: string;
}): string {
  const origin =
    params.location === "global"
      ? "https://aiplatform.googleapis.com"
      : `https://${params.location}-aiplatform.googleapis.com`;
  return (
    `${origin}/${GOOGLE_VERTEX_TTS_API_VERSION}` +
    `/projects/${encodeURIComponent(params.project)}` +
    `/locations/${encodeURIComponent(params.location)}` +
    `/publishers/google/models/${encodeURIComponent(params.model)}:generateContent`
  );
}

/**
 * Vertex ADC synthesis route. The deployment runs keyless on Vertex, so there
 * is no AI-Studio key; we ride the same ADC bearer the rest of the Google
 * provider uses (`resolveGoogleVertexAuthorizedUserHeaders`). This is the route
 * that closes the speech-provider Vertex gap (tulgey #10) and makes native
 * audio output the primary path (ADR 0024). Body, PCM extraction, WAV-wrap, and
 * opus transcode are shared with the AI-Studio route.
 */
async function synthesizeGoogleVertexTtsPcmOnce(params: {
  text: string;
  model: string;
  voiceName: string;
  languageCode?: string;
  audioProfile?: string;
  speakerName?: string;
  timeoutMs: number;
}): Promise<Buffer> {
  const authHeaders = await resolveGoogleVertexAuthorizedUserHeaders(fetch);
  const url = buildGoogleVertexTtsUrl({
    model: params.model,
    project: resolveGoogleVertexTtsProject(),
    location: resolveGoogleVertexTtsLocation(),
  });

  // Route through the guarded HTTP helper (SSRF/dispatcher policy, timeout),
  // not a raw fetch — same path the AI-Studio route uses.
  const { response: res, release } = await postJsonRequest({
    url,
    headers: new Headers({ ...authHeaders, "Content-Type": "application/json" }),
    body: buildGoogleSpeechGenerateContentBody({
      text: params.text,
      voiceName: params.voiceName,
      languageCode: params.languageCode,
      audioProfile: params.audioProfile,
      speakerName: params.speakerName,
    }),
    timeoutMs: params.timeoutMs,
    fetchFn: fetch,
    pinDns: false,
  });

  try {
    if (!res.ok) {
      try {
        await assertOkOrThrowProviderError(res, "Google Vertex TTS failed");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (res.status >= 500 && res.status < 600) {
          throw new GoogleTtsRetryableError(message);
        }
        throw err;
      }
    }
    try {
      return extractGoogleSpeechPcm((await res.json()) as GoogleGenerateSpeechResponse);
    } catch (err) {
      throw new GoogleTtsRetryableError(err instanceof Error ? err.message : String(err));
    }
  } finally {
    await release();
  }
}

async function synthesizeGoogleVertexTtsPcm(params: {
  text: string;
  model: string;
  voiceName: string;
  languageCode?: string;
  audioProfile?: string;
  speakerName?: string;
  timeoutMs: number;
}): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await synthesizeGoogleVertexTtsPcmOnce(params);
    } catch (err) {
      lastError = err;
      if (!isGoogleTtsRetryableError(err) || attempt > 0) {
        throw err;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** True when no AI-Studio key is set but a Vertex ADC source is detectable. */
function googleVertexTtsAdcAvailable(apiKey: string | undefined): boolean {
  return isGoogleVertexCredentialsMarker(apiKey) && hasGoogleVertexAuthorizedUserAdcSync();
}

/**
 * Resolve speech PCM via the best available Google route.
 *
 * Primary stays the AI-Studio key route (unchanged). When no AI-Studio key is
 * configured but the deployment has Vertex ADC (the keyless-Vertex case,
 * tulgey #10 / ADR 0024), synthesize natively over the Vertex inference path
 * instead of failing. With neither, throw so the speech provider-order fallback
 * (Cloud TTS → text) trips on a detected failure, never a silent degrade
 * (ADR 0024 §2).
 */
async function resolveGoogleTtsPcm(params: {
  cfg?: OpenClawConfig;
  providerConfig: SpeechProviderConfig;
  text: string;
  model: string;
  voiceName: string;
  languageCode?: string;
  audioProfile?: string;
  speakerName?: string;
  timeoutMs: number;
}): Promise<Buffer> {
  const apiKey = resolveGoogleTtsApiKey({
    cfg: params.cfg,
    providerConfig: params.providerConfig,
  });
  if (apiKey && !isGoogleVertexCredentialsMarker(apiKey)) {
    return synthesizeGoogleTtsPcm({
      text: params.text,
      apiKey,
      baseUrl: resolveGoogleTtsBaseUrl({
        cfg: params.cfg,
        providerConfig: readGoogleTtsProviderConfig(params.providerConfig),
      }),
      request: sanitizeConfiguredModelProviderRequest(
        params.cfg?.models?.providers?.google?.request,
      ),
      model: params.model,
      voiceName: params.voiceName,
      languageCode: params.languageCode,
      audioProfile: params.audioProfile,
      speakerName: params.speakerName,
      timeoutMs: params.timeoutMs,
    });
  }
  if (googleVertexTtsAdcAvailable(apiKey)) {
    return synthesizeGoogleVertexTtsPcm({
      text: params.text,
      model: params.model,
      voiceName: params.voiceName,
      languageCode: params.languageCode,
      audioProfile: params.audioProfile,
      speakerName: params.speakerName,
      timeoutMs: params.timeoutMs,
    });
  }
  throw new Error(
    "Google TTS unavailable: no AI-Studio API key and no Vertex ADC credentials detected.",
  );
}

/**
 * Resolve the BCP-47 languageCode for a synthesis, by precedence:
 * directive/talk override > operator config > auto-detection > omit (#251).
 * Auto-detection abstains unless it is confident the text is Spanish, so Farsi
 * and English keep Gemini's script-based auto-selection.
 */
function resolveGoogleTtsLanguageCode(params: {
  text: string;
  config: GoogleTtsProviderConfig;
  overrides: GoogleTtsProviderOverrides;
}): string | undefined {
  const explicit = params.overrides.languageCode ?? params.config.languageCode;
  if (explicit) {
    return explicit;
  }
  if (params.config.detectLanguage === false) {
    return undefined;
  }
  return detectGoogleTtsLanguageCode(params.text);
}

export function buildGoogleSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "google",
    label: "Google",
    autoSelectOrder: 50,
    defaultModel: DEFAULT_GOOGLE_TTS_MODEL,
    models: GOOGLE_TTS_MODELS,
    voices: GOOGLE_TTS_VOICES,
    resolveConfig: ({ rawConfig }) => normalizeGoogleTtsProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      const base = normalizeGoogleTtsProviderConfig(baseTtsConfig);
      return {
        ...base,
        ...(talkProviderConfig.apiKey === undefined
          ? {}
          : {
              apiKey: normalizeResolvedSecretInputString({
                value: talkProviderConfig.apiKey,
                path: "talk.providers.google.apiKey",
              }),
            }),
        ...(trimToUndefined(talkProviderConfig.baseUrl) == null
          ? {}
          : { baseUrl: trimToUndefined(talkProviderConfig.baseUrl) }),
        ...(trimToUndefined(talkProviderConfig.modelId) == null
          ? {}
          : { model: normalizeGoogleTtsModel(talkProviderConfig.modelId) }),
        ...(trimToUndefined(talkProviderConfig.voiceId) == null
          ? {}
          : { voiceName: normalizeGoogleTtsVoiceName(talkProviderConfig.voiceId) }),
      };
    },
    resolveTalkOverrides: ({ params }) => ({
      ...(trimToUndefined(params.voiceId) == null
        ? {}
        : { voiceName: normalizeGoogleTtsVoiceName(params.voiceId) }),
      ...(trimToUndefined(params.modelId) == null
        ? {}
        : { model: normalizeGoogleTtsModel(params.modelId) }),
    }),
    listVoices: async () => GOOGLE_TTS_VOICES.map((voice) => ({ id: voice, name: voice })),
    isConfigured: ({ cfg, providerConfig }) => {
      const apiKey = resolveGoogleTtsApiKey({ cfg, providerConfig });
      if (apiKey && !isGoogleVertexCredentialsMarker(apiKey)) {
        return true;
      }
      // Keyless Vertex: the native route is available when ADC is present.
      return hasGoogleVertexAuthorizedUserAdcSync();
    },
    prepareSynthesis: (ctx) => {
      const config = readGoogleTtsProviderConfig(ctx.providerConfig);
      const shouldWrap =
        config.promptTemplate === GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE ||
        Boolean(config.personaPrompt);
      if (!shouldWrap || isOpenClawGoogleAudioProfilePrompt(ctx.text)) {
        return undefined;
      }
      return {
        text: renderGoogleAudioProfilePrompt({
          text: ctx.text,
          persona: ctx.persona,
          personaPrompt: config.personaPrompt,
        }),
      };
    },
    synthesize: async (req) => {
      const config = readGoogleTtsProviderConfig(req.providerConfig);
      const overrides = readGoogleTtsOverrides(req.providerOverrides);
      const pcm = await resolveGoogleTtsPcm({
        cfg: req.cfg,
        providerConfig: req.providerConfig,
        text: req.text,
        model: normalizeGoogleTtsModel(overrides.model ?? config.model),
        voiceName: normalizeGoogleTtsVoiceName(overrides.voiceName ?? config.voiceName),
        languageCode: resolveGoogleTtsLanguageCode({ text: req.text, config, overrides }),
        audioProfile: overrides.audioProfile ?? config.audioProfile,
        speakerName: overrides.speakerName ?? config.speakerName,
        timeoutMs: req.timeoutMs,
      });
      if (req.target === "voice-note") {
        return {
          audioBuffer: await transcodeAudioBufferToOpus({
            audioBuffer: wrapPcm16MonoToWav(pcm),
            inputExtension: "wav",
            tempPrefix: "tts-google-",
            timeoutMs: req.timeoutMs,
          }),
          outputFormat: "opus",
          fileExtension: ".opus",
          voiceCompatible: true,
        };
      }
      return {
        audioBuffer: wrapPcm16MonoToWav(pcm),
        outputFormat: "wav",
        fileExtension: ".wav",
        voiceCompatible: false,
      };
    },
    synthesizeTelephony: async (req) => {
      const config = readGoogleTtsProviderConfig(req.providerConfig);
      const overrides = readGoogleTtsOverrides(req.providerOverrides);
      const pcm = await resolveGoogleTtsPcm({
        cfg: req.cfg,
        providerConfig: req.providerConfig,
        text: req.text,
        model: normalizeGoogleTtsModel(overrides.model ?? config.model),
        voiceName: normalizeGoogleTtsVoiceName(overrides.voiceName ?? config.voiceName),
        languageCode: resolveGoogleTtsLanguageCode({ text: req.text, config, overrides }),
        audioProfile: overrides.audioProfile ?? config.audioProfile,
        speakerName: overrides.speakerName ?? config.speakerName,
        timeoutMs: req.timeoutMs,
      });
      return {
        audioBuffer: pcm,
        outputFormat: "pcm",
        sampleRate: GOOGLE_TTS_SAMPLE_RATE,
      };
    },
  };
}

export const testing = {
  DEFAULT_GOOGLE_TTS_MODEL,
  DEFAULT_GOOGLE_TTS_VOICE,
  DEFAULT_GOOGLE_TTS_DETECTED_SPANISH_LANGUAGE,
  GOOGLE_AUDIO_PROFILE_PROMPT_TEMPLATE,
  GOOGLE_TTS_MODELS,
  GOOGLE_TTS_SAMPLE_RATE,
  buildGoogleVertexTtsUrl,
  detectGoogleTtsLanguageCode,
  googleVertexTtsAdcAvailable,
  normalizeGoogleTtsLanguageCode,
  normalizeGoogleTtsModel,
  renderGoogleAudioProfilePrompt,
  resolveGoogleTtsLanguageCode,
  wrapPcm16MonoToWav,
};
export { testing as __testing };
