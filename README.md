# opencode-voice-plugin

Spoken replies for [OpenCode](https://opencode.ai), powered by the hosted
[Kokoro](https://kokoro.shivrajan.com) text-to-speech service.

When a session finishes, the plugin reads the final assistant reply aloud. Subagent
replies are announced as they finish, and a `voice_speak` tool lets an agent speak a
short message on demand. Audio plays back to back through a single queue, so
utterances never interrupt each other.

## Features

- Speaks the final assistant message whenever a session goes idle.
- Speaks completed subagent replies, with a configurable prefix.
- Speaks each reply exactly once, even when OpenCode loads the plugin for more than one location.
- Adds a `voice_speak` tool so agents can read short messages aloud.
- Avoids a duplicate when an agent already spoke its reply through `voice_speak`.
- Adds a `/voice` command for `on`, `off`, `status`, `test`, `repeat`, `stop`,
  `voice <id>`, and `speed <value>`.
- Streams nothing and never blocks the agent: speech is queued in the background.
- Cleans Markdown, code blocks, paths, URLs, tables, and emoji before speaking.
- Chunks long replies at sentence boundaries.
- Remembers the enabled state, voice, and speed between restarts.
- Uses the same Kokoro HTTP API as the rest of the harness:
  `POST /v1/audio/speech` on `https://kokoro.shivrajan.com`.

## Requirements

- OpenCode 2.2 or newer.
- A reachable Kokoro service. The default is `https://kokoro.shivrajan.com`.
- One supported audio player:
  - macOS: `afplay`
  - Linux: `mpv`, `ffplay`, `paplay`, `aplay`, `play`, or `cvlc`
  - Windows: PowerShell (`System.Media.SoundPlayer`)
- Node.js 20 or newer for building.

## Install

Build the package first:

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

OpenCode reloads plugins when the configuration changes. No restart is needed.

Open an interactive session and run `/voice test`, or ask a question and wait for the
reply to be spoken.

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
| `speakSubagents` | boolean | `true` | Speak replies from child (subagent) sessions. |
| `announceFinished` | boolean | `false` | Say "Finished." when a parent session ends with no text. |
| `subagentPrefix` | string | `Subtask finished.` | Prefix added to subagent replies. Set to `""` to disable. |
| `minChars` | number | `2` | Skip cleaned replies shorter than this. |
| `maxChars` | number | `3000` | Maximum cleaned characters spoken per reply. |
| `chunkChars` | number | `900` | Maximum characters sent to Kokoro per request. |
| `player` | string | `auto` | Playback command, or `auto` to detect one. |
| `playerArgs` | string[] | `[]` | Extra arguments passed to the player before the file path. |
| `timeoutMs` | number | `60000` | Per-request Kokoro timeout. |
| `ignoreTitles` | string[] | `[]` | Skip sessions whose title contains any of these fragments. |
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

## How it works

The plugin registers an `experimental.idle` session hook. When a session finishes
model work, it reads the latest assistant text, cleans it, and appends it to a
single playback queue. If a session still has subagents running, the parent waits;
each child speaks its own reply when it finishes, and the parent speaks its final
summary afterwards. A `session.idle` event listener is used automatically when the
idle hook is unavailable.

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
- **Speech is too long.** Lower `maxChars` or raise `minChars`.
- **Subagents are too chatty.** Set `speakSubagents: false`.
- **Do not speak a helper session.** Add part of its title to `ignoreTitles`.
- **No audio in `opencode run`.** A non-interactive run can exit before playback
  finishes. Use the TUI or a running server.

## Smoke test

```bash
npm run smoke
```

This synthesizes one sentence through Kokoro and plays it with the detected player.

## Related

The plugin uses the same hosted Kokoro service as the OpenCode Custom Harness, and its
design was informed by `@semirhuduti/opencode-tts-voice`.

## License

MIT
