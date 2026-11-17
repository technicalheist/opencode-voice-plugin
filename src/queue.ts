interface QueueItem {
  text: string;
  tag?: string;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class SpeechQueue {
  private items: QueueItem[] = [];
  private current: { controller: AbortController } | null = null;
  private draining = false;

  constructor(
    private readonly handler: (text: string, signal: AbortSignal, tag?: string) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  get busy(): boolean {
    return this.current !== null || this.items.length > 0;
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
        try {
          await this.handler(item.text, controller.signal, item.tag);
          item.resolve();
        } catch (error) {
          if (controller.signal.aborted) item.resolve();
          else item.reject(error);
        } finally {
          this.current = null;
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
