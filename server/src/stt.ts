// Speech-to-text for voice questions. Claude doesn't take audio, so the server forwards it to any
// OpenAI-compatible /audio/transcriptions endpoint (OpenAI, Groq, a self-hosted Whisper server, ...).

export interface SttConfig {
  /** Base URL that ends before /audio/transcriptions, e.g. https://api.openai.com/v1 */
  url: string;
  key?: string;
  model: string;
}

/** Reads KIKI_STT_URL / KIKI_STT_KEY / KIKI_STT_MODEL; voice is off unless the URL and model are set. */
export function sttConfigFromEnv(env: NodeJS.ProcessEnv): SttConfig | null {
  const url = env.KIKI_STT_URL?.trim();
  const model = env.KIKI_STT_MODEL?.trim();
  if (!url || !model) return null;
  return { url: url.replace(/\/+$/, ""), key: env.KIKI_STT_KEY?.trim() || undefined, model };
}

export class SttError extends Error {}

const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

export function audioExtension(mimeType: string): string | undefined {
  return EXTENSIONS[mimeType.split(";")[0]!.trim().toLowerCase()];
}

export async function transcribe(
  config: SttConfig,
  audio: ArrayBuffer,
  mimeType: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string> {
  const extension = audioExtension(mimeType);
  if (!extension) throw new SttError("Unsupported audio format.");
  const form = new FormData();
  form.append("file", new Blob([audio], { type: mimeType }), `question.${extension}`);
  form.append("model", config.model);
  form.append("response_format", "json");

  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${config.url}/audio/transcriptions`, {
      method: "POST",
      headers: config.key ? { authorization: `Bearer ${config.key}` } : {},
      body: form,
      signal: options.signal ?? AbortSignal.timeout(30_000),
    });
  } catch {
    throw new SttError("Kiki's server could not reach the transcription service.");
  }
  if (!response.ok) {
    throw new SttError(`The transcription service returned HTTP ${response.status}.`);
  }
  const body = (await response.json().catch(() => null)) as { text?: unknown } | null;
  if (typeof body?.text !== "string") throw new SttError("The transcription service sent an unexpected reply.");
  return body.text.trim();
}
