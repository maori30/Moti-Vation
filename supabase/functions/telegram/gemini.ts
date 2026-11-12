/* Gemini calls, model failover and discovery. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { background } from "../_shared/util.ts";
import type { MediaPart } from "./tg.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";

export type HistoryMessage = { role: string; content: string; created_at?: string };

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 12_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

export function buildGeminiContents(history: HistoryMessage[], text: string, media?: MediaPart | null) {
  const contents = [];
  for (const msg of history) {
    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content || "(media only)" }],
    });
  }
  const userParts: any[] = [];
  if (media) {
    userParts.push({ inlineData: { mimeType: media.mimeType, data: media.data } });
  }
  if (text) {
    userParts.push({ text });
  }
  if (userParts.length === 0) {
    userParts.push({ text: "." });
  }
  contents.push({
    role: "user",
    parts: userParts,
  });
  return contents;
}

// Direct official Google Gemini API call (Standard REST Endpoint)
export async function callGoogleGeminiModel(
  apiKey: string,
  model: string,
  prompt: string,
  history: HistoryMessage[],
  text: string,
  timeoutMs = 12_000,
  media?: MediaPart | null,
  thinkingLevel?: "minimal" | "low",
): Promise<{ ok: true; content: string } | { ok: false; status: number; error: string }> {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const contents = buildGeminiContents(history, text, media);

    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: prompt }] },
          contents,
          generationConfig: {
            temperature: 0.88,
            topP: 0.9,
            maxOutputTokens: 2048,
            // Default "thinking" added ~4.5s per reply (measured 5.7s -> 1.1s with "minimal").
            ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
          },
        }),
      },
      timeoutMs,
    );

    if (res.ok) {
      const data = await res.json();
      const candidate = data?.candidates?.[0];
      const finishReason = candidate?.finishReason ?? "UNKNOWN";
      const content = candidate?.content?.parts?.map((p: any) => p.text ?? "").join("").trim();
      if (finishReason !== "STOP") {
        console.warn(`[gemini-warn:${model}] finishReason=${finishReason} content_len=${content?.length ?? 0}`);
      }
      if (content) return { ok: true, content };
    }

    const errText = await res.text();
    if (res.status === 400 && thinkingLevel) {
      // A model that doesn't accept thinkingConfig: retry once without it.
      return callGoogleGeminiModel(apiKey, model, prompt, history, text, timeoutMs, media, undefined);
    }
    console.error(`[gemini-error:${model}] HTTP ${res.status}: ${errText.slice(0, 300)}`);
    return { ok: false, status: res.status, error: errText };
  } catch (err) {
    console.error(`[gemini-exception:${model}] error:`, err);
    return { ok: false, status: 0, error: String(err) };
  }
}

export async function callModelWithFailover(apiKey: string, prompt: string, history: HistoryMessage[], text: string, timeoutMs: number, media?: MediaPart | null) {
  // Don't block the reply on model discovery: start with the preferred list, refresh in background.
  const available = availableModels;
  if (!available) background(listAvailableModels(apiKey), "list_models");
  for (const model of candidateModels(available)) {
    const res = await callGoogleGeminiModel(apiKey, model, prompt, history, text, timeoutMs, media, "minimal");
    if (res.ok) {
      goodModel = model;
      modelHealth.set(model, 0);
      return { content: res.content, debug: model };
    }
    const status = (res as { status: number }).status;
    if (status === 404) {
      // Model does not exist for this key: skip it for an hour.
      modelHealth.set(model, Date.now() + 3_600_000);
      if (goodModel === model) goodModel = null;
      availableCheckedAt = 0;
    } else if (status === 400 && media) {
      // Bad input (usually the attachment). Retrying other models with the same media is pointless;
      // retry once without it so the user still gets an answer.
      const retry = await callGoogleGeminiModel(apiKey, model, prompt, history, text, timeoutMs, null, "minimal");
      if (retry.ok) return { content: retry.content, debug: model };
      break;
    }
  }
  throw new Error("All candidate models failed API requests");
}

// Raw call that sends a full generateContent body (systemInstruction, generationConfig...).
export async function callGeminiRaw(model: string, payload: Record<string, unknown>, timeoutMs = 10_000, allowThinkingConfig = true): Promise<{ ok: boolean; data?: any }> {
  if (allowThinkingConfig) {
    const gen = (payload.generationConfig ?? {}) as Record<string, unknown>;
    if (!gen.thinkingConfig) payload = { ...payload, generationConfig: { ...gen, thinkingConfig: { thinkingLevel: "minimal" } } };
  }
  try {
    const res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY }, body: JSON.stringify(payload) },
      timeoutMs,
    );
    if (!res.ok) {
      const errText = (await res.text()).slice(0, 200);
      if (res.status === 400 && allowThinkingConfig) {
        const gen = { ...((payload.generationConfig ?? {}) as Record<string, unknown>) };
        delete gen.thinkingConfig;
        return callGeminiRaw(model, { ...payload, generationConfig: gen }, timeoutMs, false);
      }
      console.error(`[gemini-raw:${model}] HTTP ${res.status}: ${errText}`);
      return { ok: false };
    }
    return { ok: true, data: await res.json() };
  } catch (error) {
    console.error(`[gemini-raw:${model}] exception:`, error);
    return { ok: false };
  }
}

// Current active generation models in Google AI Studio
export const MODEL_PREFERENCE = [
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
];

export const modelHealth = new Map<string, number>();
let goodModel: string | null = null;
let availableModels: string[] | null = null;
let availableCheckedAt = 0;

export async function listAvailableModels(apiKey: string): Promise<string[] | null> {
  if (availableModels && Date.now() - availableCheckedAt < 6 * 3_600_000) return availableModels;
  try {
    const res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200`,
      { method: "GET", headers: { "x-goog-api-key": apiKey } },
      5_000,
    );
    if (!res.ok) return availableModels;
    const data = await res.json();
    const names = (data?.models ?? [])
      .filter((m: any) => (m?.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m: any) => String(m?.name ?? "").replace(/^models\//, ""));
    if (names.length) {
      availableModels = names;
      availableCheckedAt = Date.now();
      console.log(`[gemini] available models: ${names.slice(0, 12).join(", ")}`);
    }
    return availableModels;
  } catch (err) {
    console.error("[gemini] model discovery failed:", err);
    return availableModels;
  }
}

export function candidateModels(available: string[] | null): string[] {
  const now = Date.now();
  const preferred = MODEL_PREFERENCE.filter((model) => {
    const deadUntil = modelHealth.get(model) ?? 0;
    if (deadUntil > now) return false;
    return !available || available.includes(model);
  });
  if (!preferred.length && available?.length) {
    const flash = available.filter((m) => /flash/i.test(m) && !/8b|thinking|image|tts|embedding/i.test(m));
    if (flash.length) return flash.slice(0, 3);
    return available.slice(0, 3);
  }
  const ordered = goodModel && preferred.includes(goodModel)
    ? [goodModel, ...preferred.filter((m) => m !== goodModel)]
    : preferred;
  return ordered.length ? ordered : ["gemini-3.6-flash"];
}

// Generate AI reply, trying current generation Gemini models in order
export async function generateAiReply(
  prompt: string,
  history: HistoryMessage[],
  text: string,
  media?: MediaPart | null,
): Promise<{ content: string; debug?: string } | null> {
  const apiKey = GEMINI_API_KEY;
  if (!apiKey) return null;
  try {
    return await callModelWithFailover(apiKey, prompt, history, text, 10_000, media);
  } catch (e) {
    return null;
  }
}

export async function extractionModel(apiKey: string): Promise<string> {
  const available = availableModels;
  if (!available) background(listAvailableModels(apiKey), "list_models");
  for (const model of candidateModels(available)) {
    if (modelHealth.get(model) && modelHealth.get(model)! > Date.now()) continue;
    return model;
  }
  return MODEL_PREFERENCE[MODEL_PREFERENCE.length - 1];
}

// All bot text goes through toTelegramHtml: user/AI text is escaped (a "<3" used to make Telegram
// reject the whole message) and **bold** becomes <b>bold</b>.

/** Model that answered last (for /diag). */
export function activeModel(): string | null {
  return goodModel;
}

/** Speech-to-text for Telegram voice notes (fast model, no thinking). Returns null on failure. */
export async function transcribeAudio(media: MediaPart): Promise<string | null> {
  if (!GEMINI_API_KEY) return null;
  const model = await extractionModel(GEMINI_API_KEY);
  const res = await callGeminiRaw(model, {
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: media.mimeType, data: media.data } },
        { text: "תמלל את ההודעה הקולית מילה במילה, בשפה שבה דיברו (בדרך כלל עברית). החזר רק את התמלול עצמו, בלי הקדמות ובלי תוספות. אם אין דיבור ברור, החזר מחרוזת ריקה." },
      ],
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 800 },
  }, 15_000);
  if (!res.ok) return null;
  const text = (res.data?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("").trim();
  return text && text.length < 4000 ? text : null;
}
