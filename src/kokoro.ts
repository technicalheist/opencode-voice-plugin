export interface KokoroConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  voice: string;
  speed: number;
  timeoutMs: number;
}

export class KokoroError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'KokoroError';
  }
}

export async function synthesizeSpeech(
  text: string,
  config: KokoroConfig,
  signal?: AbortSignal,
  debug?: (message: string) => void,
): Promise<Buffer> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error('Kokoro request timed out.')), config.timeoutMs);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

    debug?.(`requesting ${text.length} characters from ${config.baseUrl}`);
    const response = await fetch(`${config.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        input: text,
        voice: config.voice,
        response_format: 'wav',
        speed: config.speed,
        stream: false,
      }),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 400).trim();
      throw new KokoroError(
        `Kokoro returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        response.status,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    const audio = Buffer.from(await response.arrayBuffer());
    if (contentType.includes('application/json')) {
      throw new KokoroError(`Kokoro returned JSON instead of audio: ${audio.toString('utf8').slice(0, 300)}`);
    }
    if (audio.length < 64) {
      throw new KokoroError('Kokoro returned an empty audio response.');
    }
    debug?.(`received ${audio.length} bytes (${contentType || 'unknown type'})`);
    return audio;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
