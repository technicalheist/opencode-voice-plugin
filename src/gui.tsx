import { createEffect, createSignal } from "solid-js";
import {
  Command,
  ComposerPill,
  Plugin,
  type ComposerPillView,
} from "@opencode/plugin/gui";
import { Voice } from "./rpc.js";

type Mode = "idle" | "listening" | "transcribing" | "working" | "speaking";
type CaptureKind = "dictation" | "conversation";

const SPINNER = ["◐", "◓", "◑", "◒"];
const START_GRACE_MS = 7000;
const SILENCE_MS = 5000;
const MAX_CAPTURE_MS = 120_000;

function withTimeout<T>(value: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("timeout")), ms);
    value.then(
      (result) => {
        window.clearTimeout(timer);
        resolve(result);
      },
      (cause) => {
        window.clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const NOISE_WORD = /^(music|applause|laughter|noise|silence|inaudible|sound|sounds|beep|beeping)$/i;
const HALLUCINATION =
  /^(thank you for watching|thanks for watching|please subscribe.*|subtitles? by .*)$/i;

function speechWords(text: string): string[] {
  const stripped = text
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/[\u266A\u266B\u266C\u2669]/g, " ")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped || HALLUCINATION.test(stripped)) return [];
  return stripped.split(" ").filter((word) => word && !NOISE_WORD.test(word));
}

function usableSpeech(text: string): boolean {
  return speechWords(text).length >= 2;
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
    const [conversationProject, setConversationProject] = createSignal("");
    const [output, setOutput] = createSignal(true);
    const [heard, setHeard] = createSignal("");
    const [error, setError] = createSignal("");
    const [starting, setStarting] = createSignal(false);
    const [tick, setTick] = createSignal(0);

    const spinner = () => SPINNER[tick() % SPINNER.length] ?? "◐";

    const voice = () => ctx.client.rpc(Voice);

    let captureActive = false;
    let captureKind: CaptureKind = "conversation";
    let captureProject = "";
    let discardCapture = false;
    let recorder: MediaRecorder | null = null;
    let stream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let silenceTimer: number | undefined;
    let chunks: Blob[] = [];
    let recordedType = "audio/webm";
    let disposed = false;

    const notify = (message: string, variant: "success" | "default" | "error" = "default") => {
      ctx.toast.show({ title: "Voice", description: message, variant, duration: 4000 });
    };

    const projectKey = (): string => {
      const session = ctx.sessions.current();
      const root = session?.project?.worktree ?? session?.listedProject?.worktree;
      return session && root ? `${session.server.id}\n${root}` : "";
    };

    const conversationActive = (): boolean => {
      const scope = conversationProject();
      return conversation() && scope !== "" && projectKey() === scope;
    };

    const maybeListen = () => {
      if (disposed || !conversationActive()) return;
      window.setTimeout(() => {
        if (disposed) return;
        if (conversationActive() && !captureActive && mode() === "idle") {
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
      let speechStartedAt = 0;
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
          if (!speechStarted) speechStartedAt = now;
          speechStarted = true;
          lastVoice = now;
        }
        if (!speechStarted) {
          if (captureKind === "conversation") {
            if (now - startedAt > MAX_CAPTURE_MS) stopCapture(true);
          } else if (now - startedAt > START_GRACE_MS) {
            stopCapture(true);
          }
          return;
        }
        if (now - lastVoice > SILENCE_MS) {
          stopCapture(false);
          return;
        }
        if (now - speechStartedAt > MAX_CAPTURE_MS) stopCapture(false);
      }, 100);
    };

    const finishCapture = async () => {
      const current = recorder;
      recorder = null;
      if (discardCapture || chunks.length === 0) {
        setMode("idle");
        maybeListen();
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
      if (disposed || starting() || captureActive || recorder) return;
      if (kind === "conversation" && !conversationActive()) return;
      if (mode() === "transcribing" || mode() === "speaking" || mode() === "working") return;
      const session = ctx.sessions.current();
      if (!session) {
        notify("Open a session before using voice mode.", "default");
        return;
      }
      captureKind = kind;
      setStarting(true);
      setError("");
      try {
        let busy = false;
        try {
          const info = await withTimeout(
            session.server.client.session.get({ sessionID: session.id }),
            2500,
          );
          const time = info.time;
          busy = Boolean(time.busy && (!time.idle || time.busy > time.idle));
        } catch {
          // A slow status check must not block voice input.
        }
        if (ctx.signal.aborted) return;
        if (busy) {
          if (conversationActive()) {
            window.setTimeout(() => {
              if (conversationActive() && mode() === "idle") void startListening("conversation");
            }, 1500);
          }
          return;
        }
        try {
          await withTimeout(
            voice().dictate({ sessionID: session.id, silent: kind === "dictation" }),
            3000,
          );
        } catch {
          // The dictation flag is optional; keep recording if an older server does not have it.
        }
        const media = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (ctx.signal.aborted || (kind === "conversation" && !conversationActive())) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = media;
        captureActive = true;
        captureProject = projectKey();
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
        maybeListen();
        return;
      }
      if (captureKind === "conversation") {
        if (captureProject !== projectKey()) {
          setMode("idle");
          notify("Voice input was discarded because the project changed.", "default");
          return;
        }
        if (!conversation()) {
          setMode("idle");
          return;
        }
      }
      setMode("transcribing");
      try {
        const audio = await blobToBase64(blob);
        if (ctx.signal.aborted) return;
        const format = type.includes("ogg") ? "ogg" : "webm";
        const result = (await voice().transcribe({ audio, format })) as { text: string };
        if (ctx.signal.aborted) return;
        const text = result.text.trim();
        if (!usableSpeech(text)) {
          setMode("idle");
          notify("No speech was detected.", "default");
          maybeListen();
          return;
        }
        if (captureKind === "conversation") {
          if (captureProject !== projectKey()) {
            setMode("idle");
            notify("Voice input was discarded because the project changed.", "default");
            return;
          }
          if (!conversation()) {
            setMode("idle");
            return;
          }
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
        // Stop locally even if the server call fails.
      }
      setMode("idle");
      maybeListen();
    }

    function toggleMic(): void {
      if (captureActive) {
        if (captureKind === "conversation") {
          setConversation(false);
          setConversationProject("");
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
      setConversationProject("");
      void startListening("dictation");
    }

    function toggleConversation(): void {
      const scope = projectKey();
      const activeHere = conversation() && scope !== "" && conversationProject() === scope;
      if (activeHere) {
        const speaking = mode() === "speaking";
        setConversation(false);
        setConversationProject("");
        stopCapture(true);
        if (speaking) void voice().stop({}).catch(() => {});
        notify("Conversation mode off.", "default");
        return;
      }
      if (!scope) {
        notify("Open a project before using conversation mode.", "default");
        return;
      }
      if (conversation()) {
        void voice().stop({}).catch(() => {});
        stopCapture(true);
      }
      if (captureActive && captureKind === "dictation") stopCapture(true);
      setConversationProject(scope);
      setConversation(true);
      void voice()
        .configure({ enabled: true })
        .then((value) => setOutput((value as { enabled: boolean }).enabled))
        .catch(() => {});
      notify("Conversation mode on. Speak naturally.", "success");
      if (mode() === "idle") void startListening("conversation");
    }

    createEffect(() => {
      if (!conversation()) return;
      const scope = conversationProject();
      const current = projectKey();
      if (scope && current === scope) return;
      setConversation(false);
      setConversationProject("");
      stopCapture(true);
      void voice().stop({}).catch(() => {});
      notify(
        current
          ? "Conversation mode stopped. It runs in one project at a time."
          : "Conversation mode off.",
        "default",
      );
    });

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
    const pulseIcon = () =>
      Math.floor(tick() / 2) % 2 === 0 ? "outline-wave-audio" : "waveform";

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

    ctx.add(ComposerPill, {
      id: "mic",
      order: 10,
      show: (): ComposerPillView | undefined => {
        const loading = (starting() && captureKind === "dictation") || micTranscribing();
        if (loading) {
          return {
            label: spinner(),
            tone: "warning",
            title: micTranscribing() ? "Dictate: transcribing" : "Dictate: starting",
            run: () => toggleMic(),
          };
        }
        if (micListening()) {
          return {
            icon: "outline-audio",
            label: "Listening",
            tone: "danger",
            title: "Dictate: listening",
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
        const loading =
          (starting() && captureKind === "conversation") ||
          (current === "transcribing" && captureKind === "conversation") ||
          current === "working";
        if (loading) {
          return {
            label: spinner(),
            tone: "warning",
            title: "Voice conversation mode",
            run: toggleConversation,
          };
        }
        if (current === "speaking") {
          return {
            icon: pulseIcon(),
            label: "Speaking",
            tone: "success",
            title: "Stop speaking",
            run: () => void stopSpeaking(),
          };
        }
        if (current === "listening" && captureKind === "conversation") {
          return {
            icon: pulseIcon(),
            label: "Listening",
            tone: "danger",
            title: "Voice conversation mode",
            run: toggleConversation,
          };
        }
        return {
          icon: "waveform",
          label: "",
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
      disposed = true;
      window.clearInterval(spinnerTimer);
      window.clearInterval(statusTimer);
      unsubscribe();
      stopCapture(true);
    };
  },
});
