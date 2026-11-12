/* Telegram Bot API helpers. */
import { telegramCall, toTelegramHtml } from "../_shared/util.ts";

const TG_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";

export type MediaPart = { mimeType: string, data: string };

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const chunk = 32768;
    let result = '';
    for (let i = 0; i < bytes.length; i += chunk) {
        result += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    return btoa(result);
}

export async function getTelegramFile(fileId: string): Promise<MediaPart | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`);
    const json = await res.json();
    if (!json.ok) return null;

    const filePath = json.result.file_path;
    const ext = filePath.split('.').pop()?.toLowerCase();
    
    // tgs is lottie animation (json), Gemini doesn't support it visually. Skip download entirely.
    if (ext === "tgs") return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    let fileRes: Response;
    try {
      fileRes = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const buffer = await fileRes.arrayBuffer();
    
    // Skip files larger than 1MB to avoid timeouts
    if (buffer.byteLength > 1_048_576) return null;
    
    const base64 = arrayBufferToBase64(buffer);
    
    // Only types Gemini accepts inline. Anything else is dropped (sending it would make
    // Gemini return 400 for every model).
    const MIME: Record<string, string> = {
      ogg: "audio/ogg", oga: "audio/ogg", mp3: "audio/mp3", m4a: "audio/mp4", wav: "audio/wav",
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic",
      mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf", txt: "text/plain", vcf: "text/vcard",
    };
    const mimeType = MIME[ext ?? ""];
    if (!mimeType) return null;

    return { mimeType, data: base64 };
  } catch (error) {
    console.error("[telegram] failed to fetch media:", error);
    return null;
  }
}

export async function sendChatAction(chatId: number, action = "typing") {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch (error) {
    console.error("[telegram] sendChatAction failed:", error);
  }
}


export async function sendMessage(chatId: number, text: string, keyboard?: object): Promise<number | null> {
  const body: Record<string, unknown> = { chat_id: chatId, text: toTelegramHtml(text), parse_mode: "HTML" };
  if (keyboard) body.reply_markup = keyboard;
  const result = await telegramCall(TG_TOKEN, "sendMessage", body);
  return result?.result?.message_id ?? null;
}

export async function sendTelegramAnimation(chatId: number, animationUrl: string, caption: string, keyboard?: object): Promise<boolean> {
  const body: Record<string, unknown> = { chat_id: chatId, animation: animationUrl, caption: toTelegramHtml(caption), parse_mode: "HTML" };
  if (keyboard) body.reply_markup = keyboard;
  return Boolean(await telegramCall(TG_TOKEN, "sendAnimation", body, "caption"));
}

export async function sendPhoto(chatId: number, photo: string, caption?: string): Promise<boolean> {
  const body: Record<string, unknown> = { chat_id: chatId, photo };
  if (caption) { body.caption = toTelegramHtml(caption); body.parse_mode = "HTML"; }
  return Boolean(await telegramCall(TG_TOKEN, "sendPhoto", body, "caption"));
}

export async function pinChatMessage(chatId: number, messageId: number) {
  const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, disable_notification: false };
  const response = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/pinChatMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) console.error(`[telegram] pin failed ${response.status}: ${(await response.text()).slice(0, 300)}`);
}


export async function answerCallback(id: string) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callback_query_id: id }) });
}

export async function editMessageReplyMarkup(chatId: number, messageId: number, replyMarkup: object = { inline_keyboard: [] }) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: replyMarkup }),
    });
  } catch (error) {
    console.error("[telegram] editMessageReplyMarkup exception:", error);
  }
}

// Master conversational AI prompt: deep comprehension, culture, quick wit & natural flow
