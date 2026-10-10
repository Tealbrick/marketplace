import { webcrypto } from "node:crypto";

import type { VoiceOptions } from "@tealbrick/voice";
import { beforeAll, describe, expect, it } from "vitest";

import { writeOggOpus } from "../providers/ogg-opus.js";

import { SpeechProviderError } from "./speech.js";
import { opusPacket } from "./test-support.js";
import { createPortalVoiceSpeechProvider, type PortalSession } from "./voice-speech.js";

// Fake transport only: a local ES256 Portal identity (WebCrypto) and a fake provider `fetch`. Nothing leaves the
// process; the speech endpoint URL is an unresolvable test name that is never dialled.

type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;

const ISSUER = "https://portal.test";
const ORG = "org-huddle";
const AGENT = "agent-huddle";
const STT_URL = "https://speech.provider.test/v1/audio/transcriptions";
const TTS_URL = "https://speech.provider.test/v1/audio/speech";

let keys: CryptoKeyPair;
let otherKeys: CryptoKeyPair;

beforeAll(async () => {
  keys = (await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  otherKeys = (await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
});

async function jwt(claims: Record<string, unknown>, signer: CryptoKey = keys.privateKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "ES256", typ: "JWT" })}.${encode({ iss: ISSUER, iat: now, exp: now + 300, ...claims })}`;
  const signature = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer, Buffer.from(input));
  return `${input}.${Buffer.from(signature).toString("base64url")}`;
}

async function ownerSession(input: { agent?: string; signer?: CryptoKey } = {}): Promise<PortalSession> {
  return {
    idToken: await jwt({ sub: "owner-1", org: ORG }, input.signer),
    bundle: await jwt({ user: "owner-1", org: ORG, agentGrants: [{ agent: input.agent ?? AGENT, level: "use" }] }, input.signer),
  };
}

function voiceOptions(provider: { requests: Array<{ url: string; authorization: string | null; form: FormData | null; body: string | null }>; reply: () => Response }): VoiceOptions {
  return {
    auth: { issuer: ISSUER, org: ORG, agent: AGENT, keys: (async () => keys.publicKey) as never },
    getConfig: () => ({
      version: 1,
      enabled: true,
      displayName: "Huddle agent",
      transcription: { protocol: "openai-audio-v1", url: STT_URL, model: "stt-test", credentialRef: "huddle-speech" },
      synthesis: { protocol: "openai-audio-v1", url: TTS_URL, model: "tts-test", voice: "calm", credentialRef: "huddle-speech" },
    }),
    endpoints: [
      { url: STT_URL, credentialRefs: ["huddle-speech"] },
      { url: TTS_URL, credentialRefs: ["huddle-speech"] },
    ],
    resolveCredential: ({ reference }) => {
      if (reference !== "huddle-speech") throw new Error("unknown reference");
      return "fake-provider-key";
    },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body;
      provider.requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
        form: body instanceof FormData ? body : null,
        body: typeof body === "string" ? body : null,
      });
      return provider.reply();
    }) as typeof fetch,
  };
}

describe("@tealbrick/voice SpeechProvider adapter (disabled by default)", () => {
  it("refuses to construct unless explicitly enabled", () => {
    const provider = { requests: [], reply: () => Response.json({ text: "x" }) };
    for (const enabled of [false, undefined, "true", 1]) {
      expect(() => createPortalVoiceSpeechProvider({ enabled: enabled as boolean, voice: voiceOptions(provider), portalSession: ownerSession })).toThrow(SpeechProviderError);
    }
  });

  it("transcribes Ogg/Opus through the Portal-authorized handler with the provider key resolved at runtime", async () => {
    const provider = { requests: [] as Array<{ url: string; authorization: string | null; form: FormData | null; body: string | null }>, reply: () => Response.json({ text: "hello from the huddle" }) };
    const speech = createPortalVoiceSpeechProvider({ enabled: true, voice: voiceOptions(provider), portalSession: () => ownerSession() });
    const ogg = writeOggOpus(Array.from({ length: 10 }, (_unused, index) => opusPacket(index)));
    expect(await speech.transcribe(ogg, { language: "en" })).toEqual({ text: "hello from the huddle" });
    expect(provider.requests).toHaveLength(1);
    const [request] = provider.requests;
    expect(request!.url).toBe(STT_URL);
    expect(request!.authorization).toBe("Bearer fake-provider-key");
    const file = request!.form!.get("file") as File;
    expect(file.name).toBe("recording.ogg");
    expect(file.type).toBe("audio/ogg");
    expect(Buffer.from(await file.arrayBuffer()).equals(Buffer.from(ogg))).toBe(true);
    expect(request!.form!.get("model")).toBe("stt-test");
    expect(request!.form!.get("response_format")).toBe("json");
  });

  it("refuses before any provider dispatch without a valid owner Portal session or grant", async () => {
    const provider = { requests: [] as Array<{ url: string; authorization: string | null; form: FormData | null; body: string | null }>, reply: () => Response.json({ text: "never" }) };
    const ogg = writeOggOpus([opusPacket(1)]);
    const cases: Array<[() => Promise<PortalSession>, string]> = [
      [() => ownerSession({ signer: otherKeys.privateKey }), "invalid_session"],
      [() => ownerSession({ agent: "another-agent" }), "agent_not_granted"],
      [async () => ({ idToken: "", bundle: "" }), "portal_session_unavailable"],
    ];
    for (const [session, code] of cases) {
      const speech = createPortalVoiceSpeechProvider({ enabled: true, voice: voiceOptions(provider), portalSession: session });
      await expect(speech.transcribe(ogg, {})).rejects.toMatchObject({ code });
    }
    expect(provider.requests).toEqual([]);
  });

  it("maps provider failures to stable codes", async () => {
    const provider = { requests: [] as Array<{ url: string; authorization: string | null; form: FormData | null; body: string | null }>, reply: () => new Response("provider secret detail", { status: 500 }) };
    const speech = createPortalVoiceSpeechProvider({ enabled: true, voice: voiceOptions(provider), portalSession: () => ownerSession() });
    const error = await speech.transcribe(writeOggOpus([opusPacket(1)]), {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpeechProviderError);
    expect((error as SpeechProviderError).code).toMatch(/^voice_/u);
    expect(String((error as Error).message)).not.toContain("secret");
  });

  it("refuses synthesis before dispatch: the package only returns MP3, a huddle needs Ogg/Opus", async () => {
    const provider = { requests: [] as Array<{ url: string; authorization: string | null; form: FormData | null; body: string | null }>, reply: () => new Response(new Uint8Array([0xff, 0xfb]), { headers: { "content-type": "audio/mpeg" } }) };
    const speech = createPortalVoiceSpeechProvider({ enabled: true, voice: voiceOptions(provider), portalSession: () => ownerSession() });
    await expect(speech.synthesize("hello", {})).rejects.toMatchObject({ code: "speech_ogg_opus_unavailable" });
    expect(provider.requests).toEqual([]);
  });
});
