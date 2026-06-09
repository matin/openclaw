import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const transcodeAudioBufferToOpusMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  transcodeAudioBufferToOpus: transcodeAudioBufferToOpusMock,
}));

const {
  assertOkOrThrowProviderErrorMock,
  postJsonRequestMock,
  resolveProviderHttpRequestConfigMock,
} = getProviderHttpMocks();

let buildGoogleSpeechProvider: typeof import("./speech-provider.js").buildGoogleSpeechProvider;
let testing: typeof import("./speech-provider.js").testing;

beforeAll(async () => {
  ({ buildGoogleSpeechProvider, testing } = await import("./speech-provider.js"));
});

installProviderHttpMockCleanup();

function googleTtsResponse(pcm = Buffer.from([1, 0, 2, 0])) {
  return {
    ok: true,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              {
                inlineData: {
                  mimeType: "audio/L16;codec=pcm;rate=24000",
                  data: pcm.toString("base64"),
                },
              },
            ],
          },
        },
      ],
    }),
  };
}

function installGoogleTtsRequestMock(pcm = Buffer.from([1, 0, 2, 0])) {
  postJsonRequestMock.mockResolvedValue({
    response: googleTtsResponse(pcm),
    release: vi.fn(async () => {}),
  });
  return postJsonRequestMock;
}

function expectRecordFields(value: unknown, expected: Record<string, unknown>) {
  if (!value || typeof value !== "object") {
    throw new Error("Expected record");
  }
  const actual = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(actual[key]).toEqual(expectedValue);
  }
  return actual;
}

function requireFirstMockArg(mock: ReturnType<typeof vi.fn>, label: string): unknown {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`Expected ${label}`);
  }
  return call[0];
}

function requireFirstRecordArg(
  mock: ReturnType<typeof vi.fn>,
  label: string,
): Record<string, unknown> {
  const value = requireFirstMockArg(mock, label);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value as Record<string, unknown>;
}

describe("Google speech provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    transcodeAudioBufferToOpusMock.mockReset();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/media-runtime");
    vi.resetModules();
  });

  it("synthesizes Gemini PCM as WAV and preserves audio tags in the request text", async () => {
    const requestMock = installGoogleTtsRequestMock();
    const provider = buildGoogleSpeechProvider();

    const result = await provider.synthesize({
      text: "[whispers] The door is open.",
      cfg: {},
      providerConfig: {
        apiKey: "google-test-key",
        model: "google/gemini-3.1-flash-tts",
        voiceName: "Puck",
      },
      target: "audio-file",
      timeoutMs: 12_345,
    });

    const request = expectRecordFields(requireFirstRecordArg(requestMock, "Google TTS request"), {
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent",
      body: {
        contents: [
          {
            role: "user",
            parts: [{ text: "[whispers] The door is open." }],
          },
        ],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: "Puck",
              },
            },
          },
        },
      },
      fetchFn: fetch,
      pinDns: false,
      timeoutMs: 12_345,
    }) as { headers?: HeadersInit };
    expect(new Headers(request.headers).get("x-goog-api-key")).toBe("google-test-key");
    expect(result.outputFormat).toBe("wav");
    expect(result.fileExtension).toBe(".wav");
    expect(result.voiceCompatible).toBe(false);
    expect(result.audioBuffer.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(result.audioBuffer.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(result.audioBuffer.readUInt32LE(24)).toBe(testing.GOOGLE_TTS_SAMPLE_RATE);
    expect(result.audioBuffer.subarray(44)).toEqual(Buffer.from([1, 0, 2, 0]));
    expect(transcodeAudioBufferToOpusMock).not.toHaveBeenCalled();
  });

  it("transcodes Gemini PCM to Opus for voice-note targets", async () => {
    installGoogleTtsRequestMock(Buffer.from([5, 0, 6, 0]));
    transcodeAudioBufferToOpusMock.mockResolvedValueOnce(Buffer.from("google-opus"));
    const provider = buildGoogleSpeechProvider();

    const result = await provider.synthesize({
      text: "Send this as a voice note.",
      cfg: {},
      providerConfig: {
        apiKey: "google-test-key",
      },
      target: "voice-note",
      timeoutMs: 12_000,
    });

    expect(result).toEqual({
      audioBuffer: Buffer.from("google-opus"),
      outputFormat: "opus",
      fileExtension: ".opus",
      voiceCompatible: true,
    });
    const transcodeArg = expectRecordFields(
      requireFirstRecordArg(transcodeAudioBufferToOpusMock, "Google TTS transcode request"),
      {
        inputExtension: "wav",
        tempPrefix: "tts-google-",
        timeoutMs: 12_000,
      },
    );
    expect(Buffer.isBuffer(transcodeArg.audioBuffer)).toBe(true);
    const audioBuffer = transcodeArg.audioBuffer as Buffer;
    expect(audioBuffer.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(audioBuffer.subarray(8, 12).toString("ascii")).toBe("WAVE");
  });

  it("advertises all documented Gemini TTS-capable models", () => {
    const provider = buildGoogleSpeechProvider();

    expect(provider.models).toEqual(testing.GOOGLE_TTS_MODELS);
  });

  it("renders deterministic audio-profile-v1 prompts without generating tags", async () => {
    const provider = buildGoogleSpeechProvider();

    const prepared = await provider.prepareSynthesis?.({
      text: "[whispers] The door is open.",
      cfg: {},
      providerConfig: {
        promptTemplate: "audio-profile-v1",
        personaPrompt: "Keep a close-mic feel.",
      },
      persona: {
        id: "alfred",
        label: "Alfred",
        prompt: {
          profile: "A brilliant British butler.",
          scene: "A quiet late-night study.",
          sampleContext: "The speaker is answering a trusted operator.",
          style: "Refined and lightly amused.",
          accent: "British English.",
          pacing: "Measured.",
          constraints: ["Do not read configuration values aloud."],
        },
      },
      target: "audio-file",
      timeoutMs: 1_000,
    });

    expect(prepared?.text).toBe(
      [
        "Synthesize speech from the TRANSCRIPT section only. Use the other sections only",
        "as performance direction. Do not read section titles, notes, labels, or",
        "configuration aloud.",
        "",
        "# AUDIO PROFILE: Alfred",
        "A brilliant British butler.",
        "",
        "## THE SCENE",
        "A quiet late-night study.",
        "",
        "### DIRECTOR'S NOTES",
        "Style: Refined and lightly amused.",
        "Accent: British English.",
        "Pacing: Measured.",
        "Constraints:",
        "- Do not read configuration values aloud.",
        "Provider notes:",
        "Keep a close-mic feel.",
        "",
        "### SAMPLE CONTEXT",
        "The speaker is answering a trusted operator.",
        "",
        "### TRANSCRIPT",
        "[whispers] The door is open.",
      ].join("\n"),
    );
  });

  it("does not wrap an OpenClaw audio-profile-v1 prompt twice", async () => {
    const provider = buildGoogleSpeechProvider();
    const text = [
      "Synthesize speech from the TRANSCRIPT section only. Use the other sections only",
      "as performance direction. Do not read section titles, notes, labels, or",
      "configuration aloud.",
      "",
      "# AUDIO PROFILE: Alfred",
      "A brilliant British butler.",
      "",
      "### TRANSCRIPT",
      "Hello.",
    ].join("\n");

    const prepared = await provider.prepareSynthesis?.({
      text,
      cfg: {},
      providerConfig: {
        promptTemplate: "audio-profile-v1",
      },
      persona: {
        id: "alfred",
        label: "Alfred",
        prompt: {
          profile: "A brilliant British butler.",
        },
      },
      target: "audio-file",
      timeoutMs: 1_000,
    });

    expect(prepared).toBeUndefined();
  });

  it("retries once when Gemini returns no audio payload", async () => {
    const pcm = Buffer.from([5, 0, 6, 0]);
    const requestSequence = vi
      .fn()
      .mockResolvedValueOnce({
        response: {
          ok: true,
          json: async () => ({ candidates: [{ content: { parts: [{ text: "not audio" }] } }] }),
        },
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: googleTtsResponse(pcm),
        release: vi.fn(async () => {}),
      });
    postJsonRequestMock.mockImplementation(requestSequence);
    const provider = buildGoogleSpeechProvider();

    const result = await provider.synthesize({
      text: "Retry this.",
      cfg: {},
      providerConfig: {
        apiKey: "google-test-key",
      },
      target: "audio-file",
      timeoutMs: 5_000,
    });

    expect(requestSequence).toHaveBeenCalledTimes(2);
    expect(result.audioBuffer.subarray(44)).toEqual(pcm);
  });

  it("retries once when Gemini TTS fetch aborts", async () => {
    const pcm = Buffer.from([7, 0, 8, 0]);
    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";
    const requestSequence = vi
      .fn()
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce({
        response: googleTtsResponse(pcm),
        release: vi.fn(async () => {}),
      });
    postJsonRequestMock.mockImplementation(requestSequence);
    const provider = buildGoogleSpeechProvider();

    const result = await provider.synthesize({
      text: "Retry aborted fetch.",
      cfg: {},
      providerConfig: {
        apiKey: "google-test-key",
      },
      target: "audio-file",
      timeoutMs: 5_000,
    });

    expect(requestSequence).toHaveBeenCalledTimes(2);
    expect(result.audioBuffer.subarray(44)).toEqual(pcm);
  });

  it("does not retry non-transient Gemini TTS request failures", async () => {
    const requestSequence = vi.fn().mockRejectedValueOnce(new Error("invalid request"));
    postJsonRequestMock.mockImplementation(requestSequence);
    const provider = buildGoogleSpeechProvider();

    await expect(
      provider.synthesize({
        text: "Do not retry this.",
        cfg: {},
        providerConfig: {
          apiKey: "google-test-key",
        },
        target: "audio-file",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("invalid request");

    expect(requestSequence).toHaveBeenCalledTimes(1);
  });

  it("falls back to GEMINI_API_KEY and configured Google API base URL", async () => {
    vi.stubEnv("GEMINI_API_KEY", "env-google-key");
    const requestMock = installGoogleTtsRequestMock();
    const provider = buildGoogleSpeechProvider();

    expect(provider.isConfigured({ providerConfig: {}, timeoutMs: 1 })).toBe(true);

    await provider.synthesize({
      text: "Read this plainly.",
      cfg: {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
              models: [],
            },
          },
        },
      },
      providerConfig: {},
      target: "voice-note",
      timeoutMs: 10_000,
    });

    const request = expectRecordFields(requireFirstRecordArg(requestMock, "Google TTS request"), {
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent",
    }) as { headers?: HeadersInit };
    expect(new Headers(request.headers).get("x-goog-api-key")).toBe("env-google-key");
  });

  it("can reuse a configured Google model-provider API key without auth profiles", async () => {
    const requestMock = installGoogleTtsRequestMock();
    const provider = buildGoogleSpeechProvider();
    const cfg = {
      models: {
        providers: {
          google: {
            apiKey: "model-provider-google-key",
            baseUrl: "https://generativelanguage.googleapis.com",
            models: [],
          },
        },
      },
    };

    expect(provider.isConfigured({ cfg, providerConfig: {}, timeoutMs: 1 })).toBe(true);

    await provider.synthesize({
      text: "Use the configured model provider key.",
      cfg,
      providerConfig: {},
      target: "audio-file",
      timeoutMs: 10_000,
    });

    const request = requireFirstRecordArg(requestMock, "Google TTS request") as {
      headers?: HeadersInit;
    };
    expect(new Headers(request.headers).get("x-goog-api-key")).toBe("model-provider-google-key");
  });

  it("returns Gemini PCM directly for telephony synthesis", async () => {
    const pcm = Buffer.from([3, 0, 4, 0]);
    installGoogleTtsRequestMock(pcm);
    const provider = buildGoogleSpeechProvider();

    const result = await provider.synthesizeTelephony?.({
      text: "Phone call audio.",
      cfg: {},
      providerConfig: {
        apiKey: "google-test-key",
        model: "google/gemini-3.1-flash-tts",
        voice: "Kore",
        audioProfile: "Speak calmly.",
        speakerName: "Default speaker",
      },
      providerOverrides: {
        model: "google/gemini-3.1-pro-tts",
        voiceName: "Puck",
        audioProfile: "Speak brightly.",
        speakerName: "Override speaker",
      },
      timeoutMs: 5_000,
    });

    const request = expectRecordFields(
      requireFirstRecordArg(postJsonRequestMock, "Google telephony TTS request"),
      {
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-tts:generateContent",
      },
    );
    const body = request.body as {
      contents?: unknown;
      generationConfig?: { speechConfig?: unknown };
    };
    expect(body.contents).toEqual([
      {
        role: "user",
        parts: [{ text: "Speak brightly.\n\nSpeaker name: Override speaker\n\nPhone call audio." }],
      },
    ]);
    expect(body.generationConfig?.speechConfig).toEqual({
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: "Puck",
        },
      },
    });
    expect(result).toEqual({
      audioBuffer: pcm,
      outputFormat: "pcm",
      sampleRate: 24_000,
    });
  });

  it("prepends configured Gemini TTS profile text", async () => {
    const requestMock = installGoogleTtsRequestMock();
    const provider = buildGoogleSpeechProvider();

    await provider.synthesize({
      text: "Status update starts now.",
      cfg: {},
      providerConfig: {
        apiKey: "google-test-key",
        audioProfile: "Speak professionally with a calm executive tone.",
        speakerName: "Alex",
      },
      target: "audio-file",
      timeoutMs: 10_000,
    });

    const request = requireFirstRecordArg(requestMock, "Google TTS request") as {
      body?: { contents?: Array<{ parts?: Array<{ text?: string }> }> };
    };
    expect(request.body?.contents?.[0]?.parts?.[0]?.text).toBe(
      "Speak professionally with a calm executive tone.\n\n" +
        "Speaker name: Alex\n\n" +
        "Status update starts now.",
    );
  });

  it("resolves provider config and directive overrides", () => {
    const provider = buildGoogleSpeechProvider();

    expect(
      provider.resolveConfig?.({
        cfg: {},
        rawConfig: {
          providers: {
            google: {
              apiKey: "configured-key",
              model: "google/gemini-3.1-flash-tts-preview",
              voice: "Leda",
              audioProfile: "Speak warmly.",
              speakerName: "Narrator",
            },
          },
        },
        timeoutMs: 1,
      }),
    ).toEqual({
      apiKey: "configured-key",
      audioProfile: "Speak warmly.",
      baseUrl: undefined,
      model: "gemini-3.1-flash-tts-preview",
      speakerName: "Narrator",
      voiceName: "Leda",
    });

    expect(
      provider.parseDirectiveToken?.({
        key: "google_voice",
        value: "Aoede",
        policy: {
          enabled: true,
          allowText: true,
          allowProvider: true,
          allowVoice: true,
          allowModelId: true,
          allowVoiceSettings: true,
          allowNormalization: true,
          allowSeed: true,
        },
      }),
    ).toEqual({
      handled: true,
      overrides: {
        voiceName: "Aoede",
      },
    });

    expect(
      provider.parseDirectiveToken?.({
        key: "google_model",
        value: "gemini-3.1-flash-tts-preview",
        policy: {
          enabled: true,
          allowText: true,
          allowProvider: true,
          allowVoice: true,
          allowModelId: true,
          allowVoiceSettings: true,
          allowNormalization: true,
          allowSeed: true,
        },
      }),
    ).toEqual({
      handled: true,
      overrides: {
        model: "gemini-3.1-flash-tts-preview",
      },
    });
  });

  it("lists Gemini prebuilt TTS voices", async () => {
    const provider = buildGoogleSpeechProvider();

    const voices = await provider.listVoices?.({ providerConfig: {} });
    const voiceLabels = voices?.map((voice) => `${voice.id}:${voice.name}`);
    expect(voiceLabels).toContain("Kore:Kore");
    expect(voiceLabels).toContain("Puck:Puck");
  });

  it("formats Google TTS HTTP errors with provider details", async () => {
    assertOkOrThrowProviderErrorMock.mockRejectedValue(
      new Error(
        "Google TTS failed (429): Quota exceeded [code=RESOURCE_EXHAUSTED] [request_id=google_req_123]",
      ),
    );
    postJsonRequestMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          error: {
            message: "Quota exceeded",
            status: "RESOURCE_EXHAUSTED",
          },
        }),
        {
          status: 429,
          headers: { "x-request-id": "google_req_123" },
        },
      ),
      release: vi.fn(async () => {}),
    });
    const provider = buildGoogleSpeechProvider();

    await expect(
      provider.synthesize({
        text: "Read this plainly.",
        cfg: {},
        providerConfig: { apiKey: "google-test-key" },
        target: "audio-file",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(
      "Google TTS failed (429): Quota exceeded [code=RESOURCE_EXHAUSTED] [request_id=google_req_123]",
    );
  });

  it("honors configured private-network opt-in for Google TTS", async () => {
    installGoogleTtsRequestMock();

    const provider = buildGoogleSpeechProvider();
    await provider.synthesize({
      text: "hello",
      cfg: {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              request: { allowPrivateNetwork: true },
              models: [],
            },
          },
        },
      },
      providerConfig: { apiKey: "google-test-key" },
      target: "audio-file",
      timeoutMs: 12_345,
    });

    const requestConfig = expectRecordFields(
      requireFirstRecordArg(resolveProviderHttpRequestConfigMock, "Google TTS HTTP config request"),
      {
        allowPrivateNetwork: true,
      },
    );
    expectRecordFields(requestConfig.request, { allowPrivateNetwork: true });
  });

  it("honors configured private-network opt-in for Google telephony TTS", async () => {
    installGoogleTtsRequestMock();

    const provider = buildGoogleSpeechProvider();
    await provider.synthesizeTelephony?.({
      text: "hello",
      cfg: {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              request: { allowPrivateNetwork: true },
              models: [],
            },
          },
        },
      },
      providerConfig: { apiKey: "google-test-key" },
      timeoutMs: 12_345,
    });

    const requestConfig = expectRecordFields(
      requireFirstRecordArg(resolveProviderHttpRequestConfigMock, "Google TTS HTTP config request"),
      {
        allowPrivateNetwork: true,
      },
    );
    expectRecordFields(requestConfig.request, { allowPrivateNetwork: true });
  });
});

describe("Google Vertex TTS route", () => {
  it("builds the global aiplatform generateContent URL", () => {
    expect(
      testing.buildGoogleVertexTtsUrl({
        model: "gemini-3.1-flash-tts-preview",
        project: "casita-mb",
        location: "global",
      }),
    ).toBe(
      "https://aiplatform.googleapis.com/v1/projects/casita-mb/locations/global/publishers/google/models/gemini-3.1-flash-tts-preview:generateContent",
    );
  });

  it("uses a regional host for a non-global location", () => {
    expect(
      testing.buildGoogleVertexTtsUrl({
        model: "gemini-3.1-flash-tts-preview",
        project: "casita-mb",
        location: "us-central1",
      }),
    ).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/casita-mb/locations/us-central1/publishers/google/models/gemini-3.1-flash-tts-preview:generateContent",
    );
  });
});

describe("Google TTS language detection (#251)", () => {
  // Persian (Arabic script) — sound the Farsi non-regression alarm if touched.
  const FARSI = "سلام دنیا";
  const SPANISH = "Hola, hoy es un día perfecto para entrenar en la montaña.";
  const ENGLISH = "The weather is perfect for a run in the mountains today.";

  it("detects confident Spanish as es-MX", () => {
    expect(testing.detectGoogleTtsLanguageCode(SPANISH)).toBe("es-MX");
  });

  it("treats inverted punctuation as unambiguous Spanish", () => {
    expect(testing.detectGoogleTtsLanguageCode("¿Cómo estás?")).toBe("es-MX");
  });

  it("abstains on English so it keeps the default voice", () => {
    expect(testing.detectGoogleTtsLanguageCode(ENGLISH)).toBeUndefined();
  });

  it("abstains on non-Latin scripts so Farsi keeps its Persian voice", () => {
    expect(testing.detectGoogleTtsLanguageCode(FARSI)).toBeUndefined();
  });

  it("abstains on English carrying a lone Spanish loanword", () => {
    expect(
      testing.detectGoogleTtsLanguageCode("I ordered a jalapeño burrito and a soda."),
    ).toBeUndefined();
  });

  it("abstains on empty text", () => {
    expect(testing.detectGoogleTtsLanguageCode("")).toBeUndefined();
  });

  it("scores the transcript, not the English audio-profile scaffolding", () => {
    const wrapped = testing.renderGoogleAudioProfilePrompt({
      text: SPANISH,
      persona: { id: "membrane", label: "Membrane", prompt: { profile: "A warm assistant." } },
    });
    // The wrapper prose is English; detection must still see the Spanish transcript.
    expect(wrapped).toContain("Synthesize speech from the TRANSCRIPT section only.");
    expect(testing.detectGoogleTtsLanguageCode(wrapped)).toBe("es-MX");
  });

  it("normalizes BCP-47 casing and rejects malformed codes", () => {
    expect(testing.normalizeGoogleTtsLanguageCode("es-mx")).toBe("es-MX");
    expect(testing.normalizeGoogleTtsLanguageCode("EN-us")).toBe("en-US");
    expect(testing.normalizeGoogleTtsLanguageCode("ES")).toBe("es");
    expect(testing.normalizeGoogleTtsLanguageCode(undefined)).toBeUndefined();
    expect(() => testing.normalizeGoogleTtsLanguageCode("not a code!")).toThrow();
  });

  it("resolves languageCode by precedence: override > config > detect", () => {
    expect(
      testing.resolveGoogleTtsLanguageCode({
        text: SPANISH,
        config: { model: "m", voiceName: "Kore", languageCode: "es-ES" },
        overrides: { languageCode: "en-US" },
      }),
    ).toBe("en-US");
    expect(
      testing.resolveGoogleTtsLanguageCode({
        text: SPANISH,
        config: { model: "m", voiceName: "Kore", languageCode: "es-ES" },
        overrides: {},
      }),
    ).toBe("es-ES");
    expect(
      testing.resolveGoogleTtsLanguageCode({
        text: SPANISH,
        config: { model: "m", voiceName: "Kore" },
        overrides: {},
      }),
    ).toBe("es-MX");
    expect(
      testing.resolveGoogleTtsLanguageCode({
        text: SPANISH,
        config: { model: "m", voiceName: "Kore", detectLanguage: false },
        overrides: {},
      }),
    ).toBeUndefined();
  });
});

describe("Google TTS speechConfig.languageCode wiring (#251)", () => {
  function speechConfigFromFirstRequest(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const request = requireFirstRecordArg(mock, "Google TTS request") as {
      body?: { generationConfig?: { speechConfig?: Record<string, unknown> } };
    };
    const speechConfig = request.body?.generationConfig?.speechConfig;
    if (!speechConfig) {
      throw new Error("Expected speechConfig in request body");
    }
    return speechConfig;
  }

  it("emits languageCode for auto-detected Spanish", async () => {
    const requestMock = installGoogleTtsRequestMock();
    const provider = buildGoogleSpeechProvider();

    await provider.synthesize({
      text: "Hola, hoy es un día perfecto para correr en la montaña.",
      cfg: {},
      providerConfig: { apiKey: "google-test-key" },
      target: "audio-file",
      timeoutMs: 10_000,
    });

    expect(speechConfigFromFirstRequest(requestMock).languageCode).toBe("es-MX");
  });

  it("omits languageCode for Farsi so the Persian voice is preserved", async () => {
    const requestMock = installGoogleTtsRequestMock();
    const provider = buildGoogleSpeechProvider();

    await provider.synthesize({
      text: "سلام ماتین", // "salaam Matin"
      cfg: {},
      providerConfig: { apiKey: "google-test-key" },
      target: "voice-note",
      timeoutMs: 10_000,
    });

    expect(speechConfigFromFirstRequest(requestMock)).not.toHaveProperty("languageCode");
  });

  it("omits languageCode for English", async () => {
    const requestMock = installGoogleTtsRequestMock();
    const provider = buildGoogleSpeechProvider();

    await provider.synthesize({
      text: "The door is open and the lights are on.",
      cfg: {},
      providerConfig: { apiKey: "google-test-key" },
      target: "audio-file",
      timeoutMs: 10_000,
    });

    expect(speechConfigFromFirstRequest(requestMock)).not.toHaveProperty("languageCode");
  });

  it("lets explicit config languageCode override detection", async () => {
    const requestMock = installGoogleTtsRequestMock();
    const provider = buildGoogleSpeechProvider();

    await provider.synthesize({
      text: "Hola, hoy es un día perfecto para correr.",
      cfg: {},
      providerConfig: { apiKey: "google-test-key", languageCode: "es-es" },
      target: "audio-file",
      timeoutMs: 10_000,
    });

    expect(speechConfigFromFirstRequest(requestMock).languageCode).toBe("es-ES");
  });

  it("disables detection when detectLanguage is false", async () => {
    const requestMock = installGoogleTtsRequestMock();
    const provider = buildGoogleSpeechProvider();

    await provider.synthesize({
      text: "Hola, hoy es un día perfecto para correr en la montaña.",
      cfg: {},
      providerConfig: { apiKey: "google-test-key", detectLanguage: false },
      target: "audio-file",
      timeoutMs: 10_000,
    });

    expect(speechConfigFromFirstRequest(requestMock)).not.toHaveProperty("languageCode");
  });

  it("parses a [[tts:language=...]] directive into a normalized override", () => {
    const provider = buildGoogleSpeechProvider();
    const policy = {
      enabled: true,
      allowText: true,
      allowProvider: true,
      allowVoice: true,
      allowModelId: true,
      allowVoiceSettings: true,
      allowNormalization: true,
      allowSeed: true,
    };

    expect(provider.parseDirectiveToken?.({ key: "language", value: "es-mx", policy })).toEqual({
      handled: true,
      overrides: { languageCode: "es-MX" },
    });

    expect(
      provider.parseDirectiveToken?.({
        key: "language",
        value: "es-mx",
        policy: { ...policy, allowNormalization: false },
      }),
    ).toEqual({ handled: true });
  });
});
