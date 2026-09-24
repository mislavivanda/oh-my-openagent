import { z } from "zod"

export const JevWireConfigSchema = z.object({
  /** Enable this wire (default: false). When false the existing heuristic runs unchanged. */
  enabled: z.boolean().default(false),
  /** Minimum calibrated confidence required to accept a Jev answer (default: 0.8). Below it, fall through to the heuristic. */
  confidence_threshold: z.number().min(0).max(1).default(0.8),
})

export const JevIntentRoutingWireConfigSchema = z
  .object({
    /** Enable this wire (default: false). When false the existing heuristic runs unchanged. */
    enabled: z.boolean().default(false),
    /**
     * Observation-only mode. Must stay true: the apply phase that would act on a prediction is not built yet,
     * so the wire only records what it would have done.
     */
    observe_only: z
      .boolean()
      .default(true)
      .refine((value) => value === true, {
        message:
          "jev.wires.intent_routing.observe_only must stay true. Acting on intent-routing predictions is not yet implemented, and lands with the apply phase.",
      }),
    /**
     * Minimum calibrated confidence (default: 0.8). Used ONLY to label recorded predictions as high or low
     * confidence. It gates nothing at runtime while the wire is observation-only.
     */
    confidence_threshold: z.number().min(0).max(1).default(0.8),
    /**
     * Per-decision prediction timeout in milliseconds (default: 2500). This is a PER-WIRE override of the global
     * `jev.timeout_ms`, because this wire sends 4 questions where the model-error triage wire sends 1. Raising the
     * global value to fit this wire would silently change model-error triage too.
     */
    timeout_ms: z.number().int().min(100).max(30000).default(2500),
    /**
     * How long a turn stays open for further delegations before its record is sealed (default: 120000).
     * This is NOT the prediction timeout and the two must never be conflated. `timeout_ms` bounds how long we wait
     * for a Jev answer; this bounds how long a turn may still receive delegations. Sealing turns on the 2500ms
     * prediction timeout would close almost every record before its first tool call and destroy the dataset.
     */
    turn_seal_timeout_ms: z.number().int().min(1000).max(600000).default(120000),
    /** Hard cap on the serialized state payload sent with a prediction, in characters (default: 8000). */
    max_prompt_chars: z.number().int().min(256).default(8000),
    /** Hard cap on concurrent in-flight prediction dispatches (default: 8). */
    max_inflight: z.number().int().min(1).max(64).default(8),
  })
  .refine((wire) => wire.turn_seal_timeout_ms > wire.timeout_ms, {
    message:
      "jev.wires.intent_routing.turn_seal_timeout_ms must be strictly greater than timeout_ms, otherwise turns seal before their first tool call and the recorded dataset is destroyed.",
    path: ["turn_seal_timeout_ms"],
  })

const INTENT_ROUTING_WIRE_DEFAULT = {
  enabled: false,
  observe_only: true,
  confidence_threshold: 0.8,
  timeout_ms: 2500,
  turn_seal_timeout_ms: 120000,
  max_prompt_chars: 8000,
  max_inflight: 8,
} as const

export const JevWiresConfigSchema = z.object({
  /** Model-error triage wire (W4): retry, stop, or ignore a provider error. */
  model_error_triage: JevWireConfigSchema.default({ enabled: false, confidence_threshold: 0.8 }),
  /** Intent-routing wire (W1): predict the delegation shape of a turn. Observation-only for now. */
  intent_routing: JevIntentRoutingWireConfigSchema.default(INTENT_ROUTING_WIRE_DEFAULT),
})

export const JevConfigSchema = z.object({
  /** Enable the Jev decision layer (default: false). When false no backend is constructed. */
  enabled: z.boolean().default(false),
  /**
   * Decision backend: "real" calls the TypeSafe SDK, "mock" replays scripted answers, "llm-adapter" is a placeholder.
   * The API key is read ONLY from the TYPESAFE_API_KEY environment variable, never from this config.
   */
  backend: z.enum(["real", "mock", "llm-adapter"]).default("real"),
  /** Jev model alias or versioned id (default: "jev-latest"). */
  model: z.string().min(1).default("jev-latest"),
  /** Per-decision timeout in milliseconds (default: 1500). A timeout falls through to the heuristic. */
  timeout_ms: z.number().int().min(100).max(30000).default(1500),
  /** Per-wire settings. Each wire is independently gated and default-off. */
  wires: JevWiresConfigSchema.default({
    model_error_triage: { enabled: false, confidence_threshold: 0.8 },
    intent_routing: INTENT_ROUTING_WIRE_DEFAULT,
  }),
})

export type JevWireConfig = z.infer<typeof JevWireConfigSchema>
export type JevIntentRoutingWireConfig = z.infer<typeof JevIntentRoutingWireConfigSchema>
export type JevConfig = z.infer<typeof JevConfigSchema>
