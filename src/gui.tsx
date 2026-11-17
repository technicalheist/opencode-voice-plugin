import { createSignal } from "solid-js";
import {
  Command,
  ComposerPill,
  Plugin,
  Style,
  type ComposerPillView,
} from "@opencode/plugin/gui";
import { Voice } from "./rpc.js";

type Mode = "idle" | "listening" | "transcribing" | "working" | "speaking";
type CaptureKind = "dictation" | "conversation";

const SPINNER = ["◐", "◓", "◑", "◒"];

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
    const [starting, setStarting] = createSignal(false);
    const [tick, setTick] = createSignal(0);

    const spinner = () => SPINNER[tick() % SPINNER.length] ?? "◐";

    const voice = () => ctx.client.rpc(Voice);

    let captureActive = false;
    let captureKind: CaptureKind = "conversation";
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
      if (starting() || captureActive || recorder) return;
      if (mode() === "transcribing" || mode() === "speaking" || mode() === "working") return;
      const session = ctx.sessions.current();
      if (!session) {
        notify("Open a session before using voice mode.", "default");
        return;
      }
      setStarting(true);
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
        setStarting(false);
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

    const spinnerTimer = window.setInterval(() => setTick((value) => value + 1), 150);
    const statusTimer = window.setInterval(() => {
      if (!ctx.sessions.current()) return;
      const current = mode();
      if (current !== "idle" && current !== "speaking") return;
      void voice()
        .status({ source: "poll" })
        .then((value) => {
          const status = value as { speaking: boolean };
          if (!status.speaking && mode() === "speaking") {
            setMode("idle");
            maybeListen();
          } else if (status.speaking && mode() === "idle") {
            setMode("speaking");
          }
        })
        .catch(() => {});
    }, 2000);

    ctx.add(Style, `
      [aria-label="Dictate a message"] {
        transition: transform .18s ease, filter .18s ease;
      }
      [aria-label="Dictate a message"]:hover {
        filter: drop-shadow(0 0 4px #f59e0b);
      }
      [aria-label="Dictate a message"]:active {
        transform: scale(.94);
      }
      [aria-label="Dictate a message"][data-tone="warning"],
      [aria-label="Dictate: listening"],
      [aria-label="Dictate: transcribing"] {
        animation: ocvMicPulse 1.15s ease-in-out infinite;
        filter: drop-shadow(0 0 4px #f59e0b);
      }
      [aria-label="Dictate a message"][data-tone="danger"],
      [aria-label="Dictate error"] {
        filter: drop-shadow(0 0 4px #ef4444);
      }
      [aria-label="Voice conversation mode"] {
        transition: transform .18s ease;
      }
      [aria-label="Voice conversation mode"]:hover {
        transform: scale(1.06);
      }
      [aria-label="Voice conversation mode"]:active {
        transform: scale(.94);
      }
      [aria-label="Voice conversation mode"][data-tone="success"] {
        animation: ocvTalkPulse 1.8s ease-in-out infinite;
      }
      [aria-label="Voice conversation mode"][data-tone="warning"] {
        animation: ocvTalkPulse 1.1s ease-in-out infinite;
      }
      @keyframes ocvMicPulse {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.12); }
      }
      @keyframes ocvTalkPulse {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.07); }
      }
      @media (prefers-reduced-motion: reduce) {
        [aria-label="Dictate a message"], [aria-label="Voice conversation mode"] {
          animation: none !important;
        }
      }
    `);

    ctx.add(ComposerPill, {
      id: "mic",
      order: 10,
      show: (): ComposerPillView | undefined => {
        const loading = micWarn() || starting();
        if (loading) {
          return {
            label: spinner(),
            tone: "warning",
            title: starting()
              ? "Dictate: starting"
              : micListening()
                ? "Dictate: listening"
                : "Dictate: transcribing",
            run: () => toggleMic(),
          };
        }
        return {
          label: "🎤\uFE0E",
          tone: error() ? "danger" : undefined,
          title: error() ? "Dictate error" : "Dictate a message",
          run: () => {
            if (error()) {
              setError("");
              return;
            }
            toggleMic();
          },
        };
      },
    });

    ctx.add(ComposerPill, {
      id: "conversation",
      order: 11,
      show: (): ComposerPillView | undefined => {
        const current = mode();
        const loading = current === "listening" || current === "transcribing" || current === "working" || starting();
        if (loading) {
          return {
            label: spinner(),
            tone: "warning",
            title: "Voice conversation mode",
            run: toggleConversation,
          };
        }
        const live = current === "speaking" || conversation();
        return {
          icon: live && Math.floor(tick() / 2) % 2 === 0 ? "outline-wave-audio" : "waveform",
          label: "",
          tone: live ? "success" : undefined,
          title: "Voice conversation mode",
          run: toggleConversation,
        };
      },
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
      window.clearInterval(spinnerTimer);
      window.clearInterval(statusTimer);
      unsubscribe();
      stopCapture(true);
    };
  },
});
