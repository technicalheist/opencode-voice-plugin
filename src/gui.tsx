import { createSignal, Show } from "solid-js";
import { Command, Plugin, Slot, Style } from "@opencode/plugin/gui";
import { Voice } from "./rpc.js";

type Mode = "idle" | "listening" | "transcribing" | "working" | "speaking";
type CaptureKind = "dictation" | "conversation";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const size = 0x8000;
  for (let index = 0; index < bytes.length; index += size) {
    binary += String.fromCharCode(...bytes.subarray(index, index + size));
  }
  return btoa(binary);
}

export default Plugin.define({
  setup(ctx) {
    const [mode, setMode] = createSignal<Mode>("idle");
    const [conversation, setConversation] = createSignal(false);
    const [output, setOutput] = createSignal(true);
    const [heard, setHeard] = createSignal("");
    const [error, setError] = createSignal("");

    const voice = () => ctx.client.rpc(Voice);

    let captureActive = false;
    let captureKind: CaptureKind = "conversation";
    let starting = false;
    let discardCapture = false;
    let recorder: MediaRecorder | null = null;
    let stream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let silenceTimer: number | undefined;
    let chunks: Blob[] = [];
    let recordedType = "audio/webm";

    const notify = (message: string, variant: "success" | "default" | "error" = "default") => {
      ctx.toast.show({ title: "Voice", description: message, variant, duration: 4000 });
    };

    const maybeListen = () => {
      if (!conversation()) return;
      window.setTimeout(() => {
        if (conversation() && !captureActive && mode() === "idle") {
          void startListening("conversation");
        }
      }, 400);
    };

    const startSilenceWatch = (media: MediaStream) => {
      const AudioCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) return;
      audioContext = new AudioCtor();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      audioContext.createMediaStreamSource(media).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const startedAt = Date.now();
      let speechStarted = false;
      let lastVoice = startedAt;

      silenceTimer = window.setInterval(() => {
        if (!captureActive) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) {
          const sample = (value - 128) / 128;
          sum += sample * sample;
        }
        const rms = Math.sqrt(sum / data.length);
        const now = Date.now();
        if (rms > 0.02) {
          speechStarted = true;
          lastVoice = now;
        }
        if (!speechStarted && now - startedAt > 7000) {
          stopCapture(true);
          return;
        }
        if (speechStarted && now - lastVoice > 1300) {
          stopCapture(false);
          return;
        }
        if (now - startedAt > 20000) stopCapture(false);
      }, 100);
    };

    const finishCapture = async () => {
      const current = recorder;
      recorder = null;
      if (discardCapture || chunks.length === 0) {
        setMode("idle");
        return;
      }
      const type = current?.mimeType || recordedType;
      const blob = new Blob(chunks, { type });
      chunks = [];
      await transcribe(blob, type);
    };

    function stopCapture(discard: boolean): void {
      discardCapture = discard;
      captureActive = false;
      if (silenceTimer !== undefined) {
        window.clearInterval(silenceTimer);
        silenceTimer = undefined;
      }
      if (recorder && recorder.state !== "inactive") recorder.stop();
      else void finishCapture();
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      void audioContext?.close().catch(() => {});
      audioContext = null;
      if (discard) setMode("idle");
    }

    async function startListening(kind: CaptureKind = "conversation"): Promise<void> {
      if (starting || captureActive || recorder) return;
      if (mode() === "transcribing" || mode() === "speaking" || mode() === "working") return;
      const session = ctx.sessions.current();
      if (!session) {
        notify("Open a session before using voice mode.", "default");
        return;
      }
      starting = true;
      setError("");
      try {
        const info = await session.server.client.session.get({ sessionID: session.id });
        if (ctx.signal.aborted) return;
        const time = info.time;
        if (time.busy && (!time.idle || time.busy > time.idle)) {
          if (conversation()) {
            window.setTimeout(() => {
              if (conversation() && mode() === "idle") void startListening("conversation");
            }, 1500);
          }
          return;
        }
        captureKind = kind;
        try {
          await voice().dictate({ sessionID: session.id, silent: kind === "dictation" });
        } catch {
          // The dictation flag is optional; keep recording if an older server does not have it.
        }
        const media = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (ctx.signal.aborted) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = media;
        captureActive = true;
        discardCapture = false;
        chunks = [];
        recordedType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
            ? "audio/ogg;codecs=opus"
            : "audio/webm";
        recorder = new MediaRecorder(
          media,
          recordedType ? { mimeType: recordedType } : undefined,
        );
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        };
        recorder.onstop = () => void finishCapture();
        recorder.onerror = () => {
          notify("Recording failed.", "error");
          stopCapture(true);
        };
        recorder.start(250);
        setMode("listening");
        startSilenceWatch(media);
      } catch (cause) {
        captureActive = false;
        setMode("idle");
        notify(`Microphone unavailable: ${messageOf(cause)}`, "error");
      } finally {
        starting = false;
      }
    }

    async function transcribe(blob: Blob, type: string): Promise<void> {
      if (blob.size === 0) {
        setMode("idle");
        return;
      }
      setMode("transcribing");
      try {
        const audio = await blobToBase64(blob);
        if (ctx.signal.aborted) return;
        const format = type.includes("ogg") ? "ogg" : "webm";
        const result = (await voice().transcribe({ audio, format })) as { text: string };
        if (ctx.signal.aborted) return;
        const text = result.text.trim();
        if (!text) {
          setMode("idle");
          notify("No speech was detected.", "default");
          return;
        }
        setHeard(text);
        if (captureKind === "conversation") {
          await sendPrompt(text);
        } else {
          ctx.screen.current()?.composer.insert(`${text} `);
          ctx.screen.current()?.composer.focus();
          setMode("idle");
          notify(text, "success");
        }
      } catch (cause) {
        setMode("idle");
        setError(messageOf(cause));
        notify(`Transcription failed: ${messageOf(cause)}`, "error");
      }
    }

    async function waitForTurn(session: NonNullable<ReturnType<typeof ctx.sessions.current>>) {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        await delay(1000);
        if (ctx.signal.aborted) return;
        if (mode() !== "working" && mode() !== "speaking") return;
        try {
          const info = await session.server.client.session.get({ sessionID: session.id });
          const time = info.time;
          if (time.idle && (time.idle ?? 0) > (time.busy ?? 0)) {
            if (mode() === "working") {
              setMode("idle");
              maybeListen();
            }
            return;
          }
        } catch {
          continue;
        }
      }
      if (mode() === "working") {
        setMode("idle");
        maybeListen();
      }
    }

    async function sendPrompt(text: string): Promise<void> {
      const session = ctx.sessions.current();
      if (!session) {
        setMode("idle");
        notify("Open a session before using voice mode.", "default");
        return;
      }
      setMode("working");
      try {
        await session.server.client.session.prompt({ sessionID: session.id, text });
        void waitForTurn(session);
      } catch (cause) {
        setMode("idle");
        notify(`Could not send the transcript: ${messageOf(cause)}`, "error");
      }
    }

    async function stopSpeaking(): Promise<void> {
      try {
        await voice().stop({});
      } catch {
        return;
      }
      setMode("idle");
    }

    function toggleMic(): void {
      if (captureActive) {
        if (captureKind === "conversation") {
          setConversation(false);
          stopCapture(true);
        } else {
          stopCapture(false);
        }
        return;
      }
      if (mode() === "speaking") {
        void stopSpeaking();
        return;
      }
      setConversation(false);
      void startListening("dictation");
    }

    function toggleConversation(): void {
      const next = !conversation();
      setConversation(next);
      if (next) {
        if (captureActive && captureKind === "dictation") stopCapture(true);
        void voice()
          .configure({ enabled: true })
          .then((value) => setOutput((value as { enabled: boolean }).enabled))
          .catch(() => {});
        notify("Conversation mode on. Speak naturally.", "success");
        if (mode() === "idle") void startListening("conversation");
      } else {
        stopCapture(true);
        notify("Conversation mode off.", "default");
      }
    }

    async function toggleOutput(): Promise<void> {
      const next = !output();
      try {
        const result = (await voice().configure({ enabled: next })) as { enabled: boolean };
        setOutput(result.enabled);
        notify(result.enabled ? "Spoken replies on." : "Spoken replies off.", "success");
      } catch (cause) {
        notify(`Could not change voice output: ${messageOf(cause)}`, "error");
      }
    }

    async function speakTest(): Promise<void> {
      try {
        await voice().configure({ enabled: true });
        setOutput(true);
        await voice().speak({ text: "Voice is ready. Talk to me whenever you like." });
      } catch (cause) {
        notify(`Could not speak: ${messageOf(cause)}`, "error");
      }
    }

    let unsubscribe = () => {};
    try {
      unsubscribe = voice().events.on("speech", (event) => {
        const state = event.data.state;
        if (state === "speaking") {
          setMode("speaking");
          return;
        }
        if (state === "idle" && (mode() === "speaking" || mode() === "working")) {
          setMode("idle");
          maybeListen();
        }
      });
    } catch {
      notify("Live speech status is unavailable.", "default");
    }

    void voice()
      .status({ source: "gui" })
      .then((value) => {
        const status = value as { enabled: boolean; modelReady: boolean; speaking: boolean };
        setOutput(status.enabled);
        if (status.speaking) setMode("speaking");
        if (!status.modelReady) {
          notify("Local transcription is not ready. Check the Whisper model.", "default");
        }
      })
      .catch(() => {});

    const micListening = () => mode() === "listening" && captureKind === "dictation";
    const micTranscribing = () => mode() === "transcribing" && captureKind === "dictation";
    const micWarn = () => micListening() || micTranscribing();

    ctx.add(Style, `
      .ocv-fab {
        position: fixed;
        right: 26px;
        bottom: 112px;
        z-index: 70;
        display: flex;
        gap: 10px;
        pointer-events: none;
      }
      .ocv-fab-button {
        pointer-events: auto;
        position: relative;
        width: 40px;
        height: 40px;
        display: grid;
        place-items: center;
        border-radius: 999px;
        border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
        background: color-mix(in srgb, currentColor 8%, transparent);
        color: var(--v2-text-base, #6b7280);
        cursor: pointer;
        transition: color .18s ease, background .18s ease, border-color .18s ease, transform .18s ease;
        backdrop-filter: blur(12px);
      }
      .ocv-fab-button:hover {
        transform: translateY(-1px);
        background: color-mix(in srgb, currentColor 16%, transparent);
      }
      .ocv-fab-button:active { transform: scale(.94); }
      .ocv-fab-button svg { width: 20px; height: 20px; display: block; }
      .ocv-fab-button.ocv-active {
        color: #10b981;
        border-color: color-mix(in srgb, #10b981 45%, transparent);
        background: color-mix(in srgb, #10b981 14%, transparent);
      }
      .ocv-fab-button.ocv-warn {
        color: #f59e0b;
        border-color: color-mix(in srgb, #f59e0b 45%, transparent);
        background: color-mix(in srgb, #f59e0b 14%, transparent);
      }
      .ocv-fab-button.ocv-error {
        color: #ef4444;
        border-color: color-mix(in srgb, #ef4444 45%, transparent);
        background: color-mix(in srgb, #ef4444 14%, transparent);
      }
      .ocv-fab-button.ocv-listening { animation: ocvPulse 1.15s ease-in-out infinite; }
      .ocv-fab-button.ocv-working { animation: ocvPulse 1.8s ease-in-out infinite; }
      .ocv-fab-button.ocv-speaking { animation: ocvGlow 1.2s ease-in-out infinite; }
      .ocv-fab-button.ocv-transcribing::after {
        content: "";
        position: absolute;
        inset: -3px;
        border-radius: 999px;
        border: 2px solid currentColor;
        border-top-color: transparent;
        animation: ocvSpin .8s linear infinite;
      }
      .ocv-fab-button.ocv-speaking .ocv-wave line {
        transform-box: view-box;
        transform-origin: center;
        animation: ocvWave .7s ease-in-out infinite;
      }
      .ocv-fab-button.ocv-speaking .ocv-wave line:nth-child(2) { animation-delay: .08s; }
      .ocv-fab-button.ocv-speaking .ocv-wave line:nth-child(3) { animation-delay: .16s; }
      .ocv-fab-button.ocv-speaking .ocv-wave line:nth-child(4) { animation-delay: .24s; }
      .ocv-fab-button.ocv-speaking .ocv-wave line:nth-child(5) { animation-delay: .32s; }
      @keyframes ocvPulse {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.12); }
      }
      @keyframes ocvGlow {
        0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, #10b981 35%, transparent); }
        50% { box-shadow: 0 0 0 6px transparent; }
      }
      @keyframes ocvSpin { to { transform: rotate(360deg); } }
      @keyframes ocvWave {
        0%, 100% { transform: scaleY(.45); opacity: .65; }
        50% { transform: scaleY(1); opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        .ocv-fab-button, .ocv-fab-button::after, .ocv-wave line { animation: none !important; }
      }
      @media (max-width: 640px) {
        .ocv-fab { right: 14px; bottom: 92px; }
      }
    `);

    ctx.add(Slot, {
      at: "window.bottom",
      order: 100,
      render: () => (
        <Show when={ctx.sessions.current()}>
          <div class="ocv-fab">
            <button
              type="button"
              class="ocv-fab-button"
              classList={{
                "ocv-warn": micWarn(),
                "ocv-error": Boolean(error()),
                "ocv-listening": micListening(),
                "ocv-transcribing": micTranscribing(),
              }}
              aria-label="Dictate a message"
              aria-pressed={micListening() || micTranscribing()}
              title={error() || heard() || "Dictate a message"}
              onClick={() => {
                if (error()) {
                  setError("");
                  return;
                }
                toggleMic();
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
                <line x1="12" y1="18" x2="12" y2="22" />
                <line x1="8" y1="22" x2="16" y2="22" />
              </svg>
            </button>
            <button
              type="button"
              class="ocv-fab-button"
              classList={{
                "ocv-active": conversation() || mode() === "speaking" || mode() === "working",
                "ocv-listening": mode() === "listening" && captureKind === "conversation",
                "ocv-transcribing": mode() === "transcribing" && captureKind === "conversation",
                "ocv-speaking": mode() === "speaking",
                "ocv-working": conversation() && mode() === "idle",
              }}
              aria-label={conversation() ? "Turn off conversation mode" : "Start conversation mode"}
              aria-pressed={conversation()}
              title="Conversation mode"
              onClick={() => toggleConversation()}
            >
              <svg class="ocv-wave" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <line x1="4" y1="10" x2="4" y2="14" />
                <line x1="8" y1="6" x2="8" y2="18" />
                <line x1="12" y1="3" x2="12" y2="21" />
                <line x1="16" y1="6" x2="16" y2="18" />
                <line x1="20" y1="10" x2="20" y2="14" />
              </svg>
            </button>
          </div>
        </Show>
      ),
    });

    ctx.add(
      Command,
      (): Command => ({
        id: "talk",
        title: "Voice: talk now",
        description: "Record one spoken request and put it in the composer",
        keywords: "voice microphone speech dictate",
        bind: "mod+shift+m",
        section: "prompt",
        editable: true,
        run: toggleMic,
      }),
    );

    ctx.add(
      Command,
      (): Command => ({
        id: "conversation",
        title: "Voice: toggle conversation mode",
        description: "Listen, transcribe, send, and speak replies in a loop",
        keywords: "voice conversation hands free",
        bind: "mod+shift+u",
        section: "prompt",
        editable: true,
        run: toggleConversation,
      }),
    );

    ctx.add(
      Command,
      (): Command => ({
        id: "output",
        title: "Voice: toggle spoken replies",
        description: "Turn automatic reading of answers on or off",
        keywords: "voice mute unmute speak",
        run: () => void toggleOutput(),
      }),
    );

    ctx.add(
      Command,
      (): Command => ({
        id: "stop",
        title: "Voice: stop speaking",
        description: "Stop the current spoken reply",
        keywords: "voice stop silence",
        run: () => void stopSpeaking(),
      }),
    );

    ctx.add(
      Command,
      (): Command => ({
        id: "test",
        title: "Voice: speak a test sentence",
        description: "Check that Kokoro playback works",
        keywords: "voice test audio",
        run: () => void speakTest(),
      }),
    );

    return () => {
      unsubscribe();
      stopCapture(true);
    };
  },
});
