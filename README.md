# opencode-voice-plugin

Spoken replies and local voice input for [OpenCode](https://opencode.ai).

Text-to-speech uses the hosted [Kokoro](https://kokoro.shivrajan.com) service.
Speech-to-text runs locally with Whisper, so your microphone audio never leaves the
machine.

When a session finishes, the plugin reads the final assistant reply aloud. Subagent
replies are announced as they finish. In the desktop app, two icon buttons in the row
directly above the composer show when the plugin is listening, transcribing, or
speaking: a microphone for dictation and a waveform for hands-free conversation mode.

## Features

- Speaks the final assistant message whenever a session goes idle.
- Speaks completed subagent replies, with a configurable prefix.
- Speaks each reply exactly once, even when OpenCode loads the plugin for more than one location.
- Speaks in short batches of at most two sentences and prepares the next batch while the
  current one plays, so audio starts sooner and continues without long gaps.
- Adds two icon buttons in the row directly above the composer: a microphone for
  dictation and a waveform for conversation mode.
- The microphone icon records one request, writes the transcript into the composer,
  and keeps the next reply silent. It does not auto-send.
- The waveform icon starts the hands-free loop: listen, transcribe, send, speak the
  answer, and listen again.
- The icons are neutral when idle, with no text. A small spinner appears while the
  plugin starts or waits for the server. Red **Listening** shows while recording;
  green **Speaking** shows while a reply is read aloud.
- Adds keyboard shortcuts and command-palette entries for talk, voice mode, spoken
  replies, stop, and a test sentence.
- Adds a `voice_speak` tool so agents can read short messages aloud.
- Avoids a duplicate when an agent already spoke its reply through `voice_speak`.
- Adds a `/voice` command for `on`, `off`, `status`, `test`, `repeat`, `stop`,
  `voice <id>`, and `speed <value>`.
- Cleans Markdown, code blocks, paths, URLs, tables, and emoji before speaking.
- Chunks long replies at sentence boundaries.
- Remembers the enabled state, voice, and speed between restarts.
- Uses the same Kokoro HTTP API as the rest of the harness:
  `POST /v1/audio/speech` on `https://kokoro.shivrajan.com`.

## Requirements

- OpenCode 2.3 or newer. The floating controls and voice mode need the desktop app.
- A reachable Kokoro service. The default is `https://kokoro.shivrajan.com`.
- One supported audio player:
  - macOS: `afplay`
  - Linux: `mpv`, `ffplay`, `paplay`, `aplay`, `play`, or `cvlc`
  - Windows: PowerShell (`System.Media.SoundPlayer`)
- For voice input: `ffmpeg`, `whisper-cli`, and a Whisper `ggml` model.
- Node.js 20 or newer for building.

The plugin finds the model from `whisperModel`, `WHISPER_MODEL`, or the model cache
used by the OpenCode Custom Harness:

```text
~/Library/Caches/opencode-harness/ggml-tiny.en.bin
```

## Install

Build both the server and desktop GUI parts:

```bash
cd opencode-voice-plugin
npm install
npm run build
```

Then add the local package to your OpenCode configuration, either globally in
`~/.config/opencode/opencode.jsonc` or per project in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-voice-plugin",
      "options": {
        "baseUrl": "https://kokoro.shivrajan.com",
        "voice": "af_heart",
        "speed": 1
      }
    }
  ]
}
```

OpenCode reloads plugins when the configuration changes. A local package path is
rescanned when it loads. If a GUI part was added to an already loaded package, point
the config at a fresh copy or restart the app once so OpenCode rereads the package
exports.

## Using voice input

OpenCode places these two icon buttons in the row directly above the text area. The
plugin API does not expose the text area's right edge, so this is the closest
supported position.

- **Microphone icon (dictation):** click the microphone, speak, and stop. The
  transcript is inserted into the composer so you can edit it. The plugin does not
  send it automatically, and the next reply is not spoken.
- **Waveform icon (conversation):** click the waveform, or press
  `Cmd/Ctrl+Shift+U`. Speak naturally. The plugin ends each turn after about 1.3
  seconds of silence, sends the transcript, speaks the answer, and listens again.
- **Button states:** idle is the icon alone. A spinner means the plugin is starting
  or waiting for the server. Red **Listening** means it is recording. Green
  **Speaking** means audio is actually playing.
- **Short sounds are ignored.** A recording needs at least two words to count as
  speech. Music, noise, and single sounds are dropped instead of sent, and
  conversation mode keeps listening.
- **Stop listening:** click the active icon or press the talk shortcut again.
- **Stop speaking:** click the green **Speaking** button, or use the stop command
  in the command palette. In conversation mode it stops the audio and starts
  listening again.
- **Mic shortcut:** `Cmd/Ctrl+Shift+M`.

The first microphone use asks macOS for permission. Allow OpenCode in
**System Settings > Privacy & Security > Microphone**.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enable automatic speech at startup. `/voice on` and `/voice off` override and persist it. |
| `baseUrl` | string | `https://kokoro.shivrajan.com` | Kokoro service base URL. |
| `apiKey` | string | unset | Optional bearer token sent to Kokoro. |
| `model` | string | `kokoro` | Model name sent to `/v1/audio/speech`. |
| `voice` | string | `af_heart` | Kokoro voice ID, for example `af_heart`, `af_bella`, or `am_adam`. |
| `speed` | number | `1` | Speech speed, from `0.5` to `2`. |
| `speakOnIdle` | boolean | `true` | Speak the final assistant reply when a session becomes idle. |
| `speakSubagents` | boolean | `false` | Speak final replies from child (subagent) sessions. Off by default. |
| `announceFinished` | boolean | `false` | Say "Finished." when a parent session ends with no text. |
| `subagentPrefix` | string | `Subtask finished.` | Prefix added to subagent replies. Set to `""` to disable. |
| `minChars` | number | `2` | Skip cleaned replies shorter than this. |
| `maxChars` | number | `3000` | Maximum cleaned characters spoken per reply. |
| `chunkChars` | number | `260` | Maximum characters sent to Kokoro per request. Speech is also capped at two sentences per request. |
| `player` | string | `auto` | Playback command, or `auto` to detect one. |
| `playerArgs` | string[] | `[]` | Extra arguments passed to the player before the file path. |
| `timeoutMs` | number | `60000` | Per-request Kokoro timeout. |
| `ignoreTitles` | string[] | `[]` | Skip sessions whose title contains any of these fragments. |
| `whisperModel` | string | unset | Path to a Whisper `ggml` model. Overrides `WHISPER_MODEL`. |
| `whisperLanguage` | string | `en` | Whisper language code. |
| `debug` | boolean | `false` | Write `[voice]` debug lines to the OpenCode server log. |

## Commands

| Command | What it does |
| --- | --- |
| `/voice` or `/voice status` | Show whether voice is on, the current voice, speed, service, and player. |
| `/voice on` | Enable automatic speech and persist it. |
| `/voice off` | Disable automatic speech, stop playback, and persist it. |
| `/voice test` | Speak a test sentence. |
| `/voice repeat` | Speak the latest assistant reply again. |
| `/voice stop` | Stop the current utterance and clear the queue. |
| `/voice voice af_bella` | Change the Kokoro voice. |
| `/voice speed 1.1` | Change the speed, from `0.5` to `2`. |

## Tool

`voice_speak` accepts one field:

```json
{ "text": "The deployment finished successfully." }
```

Normal replies are spoken automatically. The tool is for short messages while work is
still running. If an agent uses it for the same text as its final reply, the plugin
skips the automatic repeat.

## Logs

The plugin writes small operational files to the system temp directory under
`opencode-voice-plugin/`:

- `speech.log`: one line per queued item and Kokoro request.
- `debug.log`: setup and idle details when `debug` is `true`.
- `settings.json`: the current on/off state, voice, and speed.
- `locks/`: one short-lived marker per spoken reply, used to avoid duplicates.

Transcription audio is written to a temporary folder, converted, transcribed, and
deleted. The GUI sends the recording to the local server over the OpenCode RPC
channel; it is not uploaded.

## How it works

The server part registers an `experimental.idle` session hook. When a session
finishes model work, it reads the latest assistant text, cleans it, and appends it to
a single playback queue. If a session still has subagents running, the parent waits;
each child speaks its own reply when it finishes, and the parent speaks its final
summary afterwards. A `session.idle` event listener is used automatically when the
idle hook is unavailable.

The desktop GUI part adds the microphone and waveform icons above the composer. It
records with the browser `MediaRecorder`, sends the audio to the server over a typed
RPC, and either inserts the transcript or sends it as the next prompt. The server
emits `speaking` and `idle` RPC events, which drive the icons and the conversation
loop. Dictation mode tells the server to keep the next reply silent.

OpenCode can load a local plugin for both the project and its `.opencode`
directory. The plugin shares one runtime and one speech queue across those
instances, and uses a lock file so each reply is spoken once.

Speech is generated with `POST /v1/audio/speech` using `response_format: "wav"`,
written to the system temp directory, played once, and deleted.

## Troubleshooting

- **No audio.** Run `/voice status` to see the detected player. Install `afplay`
  (macOS), `mpv` or `ffplay` (Linux), or set `player` explicitly.
- **Kokoro errors.** Check `curl https://kokoro.shivrajan.com/health` and set
  `debug: true`, then inspect the OpenCode server log.
- **No voice buttons.** Voice output still works from the server part. The two
  buttons need OpenCode Desktop. Reload the window after a rebuild.
- **Microphone is blocked.** Allow OpenCode in macOS **Privacy & Security >
  Microphone**, then reload the window.
- **No transcript.** Check `whisper-cli`, `ffmpeg`, and the model path. The status RPC
  reports whether the model is ready.
- **Speech is too long.** Lower `maxChars` or raise `minChars`.
- **Subagents are too chatty.** Child session replies are skipped by default. Leave
  `speakSubagents: false` unless you want them read aloud.
- **Do not speak a helper session.** Add part of its title to `ignoreTitles`.
- **No audio in `opencode run`.** A non-interactive run can exit before playback
  finishes. Use the desktop app, TUI, or a running server.

## Smoke tests

```bash
npm run smoke
npm run smoke:stt
```

`smoke` synthesizes one sentence through Kokoro and plays it with the detected player.
`smoke:stt` records a sentence with macOS `say`, transcribes it locally, and prints
the text.

## Related

The plugin uses the same hosted Kokoro service as the OpenCode Custom Harness, and its
design was informed by `@semirhuduti/opencode-tts-voice`.

## License

MIT
