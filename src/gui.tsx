import { createSignal } from "solid-js";
import {
  Command,
  ComposerPill,
  Plugin,
  TitlebarItem,
  type ComposerPillTone,
  type ComposerPillView,
} from "@opencode/plugin/gui";
import { Voice } from "./rpc.js";

type Mode = "idle" | "listening" | "transcribing" | "working" | "speaking";

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
        if (conversation() && !captureActive && mode() === "idle") void startListening();
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

    async function startListening(): Promise<void> {
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
              if (conversation() && mode() === "idle") void startListening();
            }, 1500);
          }
          return;
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
        if (conversation()) {
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
        stopCapture(false);
        return;
      }
      if (mode() === "speaking") {
        void stopSpeaking();
        return;
      }
      void startListening();
    }

    function toggleConversation(): void {
      const next = !conversation();
      setConversation(next);
      if (next) {
        notify("Voice mode on. Speak naturally.", "success");
        if (mode() === "idle") void startListening();
      } else {
        stopCapture(true);
        notify("Voice mode off.", "default");
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

    ctx.add(ComposerPill, {
      id: "voice",
      order: 10,
      show: (): ComposerPillView | undefined => {
        const current = mode();
        const speaking = current === "speaking";
        const listening = current === "listening";
        const transcribing = current === "transcribing";
        const working = current === "working";
        const on = conversation();
        const tone: ComposerPillTone | undefined = error()
          ? "danger"
          : speaking
            ? "success"
            : listening || transcribing
              ? "warning"
              : undefined;
        const label = error()
          ? "Voice error"
          : listening
            ? "Listening…"
            : transcribing
              ? "Transcribing…"
              : speaking
                ? "Speaking"
                : working
                  ? "Thinking"
                  : on
                    ? "Voice mode"
                    : "Voice";
        return {
          icon: on || speaking ? "waveform" : "outline-audio",
          label,
          tone,
          title: error() || heard() || "OpenCode voice",
          run: () => {
            if (error()) {
              setError("");
              return;
            }
            if (speaking) {
              void stopSpeaking();
              return;
            }
            toggleMic();
          },
        };
      },
    });

    ctx.add(
      TitlebarItem,
      (): TitlebarItem => ({
        id: "voice",
        label: conversation() ? "Voice mode" : "Voice",
        title: "OpenCode voice",
        icon: "waveform",
        pressed: conversation(),
        busy: mode() === "transcribing",
        run: toggleConversation,
      }),
    );

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
