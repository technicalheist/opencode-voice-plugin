interface QueueItem {
  text: string;
  tag?: string;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export type SpeechState = "speaking" | "idle";

export class SpeechQueue {
  private items: QueueItem[] = [];
  private current: { controller: AbortController } | null = null;
  private draining = false;
  private playing = false;

  constructor(
    private readonly handler: (
      text: string,
      signal: AbortSignal,
      onStart: () => void,
      tag?: string,
    ) => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly onState?: (state: SpeechState, text?: string) => void,
  ) {}

  private notify(state: SpeechState, text?: string): void {
    try {
      this.onState?.(state, text);
    } catch {
      return;
    }
  }

  get busy(): boolean {
    return this.current !== null || this.items.length > 0;
  }

  get speaking(): boolean {
    return this.playing;
  }

  push(text: string, tag?: string): void {
    void this.enqueue(text, tag).catch((error) => this.onError(error));
  }

  enqueue(text: string, tag?: string): Promise<void> {
    if (!text.trim()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.items.push({ text, tag, resolve, reject });
      void this.drain();
    });
  }

  stop(): void {
    const pending = this.items.splice(0);
    for (const item of pending) item.resolve();
    if (this.current) this.current.controller.abort();
    this.playing = false;
    this.notify("idle");
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.items.length > 0) {
        const item = this.items.shift();
        if (!item) break;
        const controller = new AbortController();
        this.current = { controller };
        const onStart = () => {
          if (this.playing) return;
          this.playing = true;
          this.notify("speaking", item.text);
        };
        try {
          await this.handler(item.text, controller.signal, onStart, item.tag);
          item.resolve();
        } catch (error) {
          if (controller.signal.aborted) item.resolve();
          else item.reject(error);
        } finally {
          this.current = null;
          if (this.items.length === 0) {
            this.playing = false;
            this.notify("idle");
          }
        }
      }
    } finally {
      this.draining = false;
      if (this.items.length === 0) this.playing = false;
    }
  }
}
