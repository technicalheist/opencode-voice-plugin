import { Rpc } from "@opencode/schema/rpc";

const status = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    voice: { type: "string" },
    speed: { type: "number" },
    speaking: { type: "boolean" },
    player: { type: "string" },
    modelReady: { type: "boolean" },
    model: { type: "string" },
    guiLoads: { type: "number" },
  },
  required: ["enabled", "voice", "speed", "speaking", "player", "modelReady", "model", "guiLoads"],
  additionalProperties: false,
} as const;

export const Voice = Rpc.define({
  id: "opencode-voice-plugin",
  methods: {
    transcribe: {
      input: {
        type: "object",
        properties: {
          audio: { type: "string" },
          format: { type: "string" },
          language: { type: "string" },
        },
        required: ["audio", "format"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    status: {
      input: {
        type: "object",
        properties: { source: { type: "string" } },
        additionalProperties: false,
      },
      output: status,
    },
    configure: {
      input: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          voice: { type: "string" },
          speed: { type: "number" },
        },
        additionalProperties: false,
      },
      output: status,
    },
    speak: {
      input: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    stop: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { stopped: { type: "boolean" } },
        required: ["stopped"],
        additionalProperties: false,
      },
    },
  },
  events: {
    speech: {
      schema: {
        type: "object",
        properties: {
          state: { type: "string" },
          text: { type: "string" },
        },
        required: ["state"],
        additionalProperties: false,
      },
    },
  },
});
