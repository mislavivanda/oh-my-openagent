import { z } from "zod"

export const JevWireConfigSchema = z.object({
  /** Enable this wire (default: false). When false the existing heuristic runs unchanged. */
  enabled: z.boolean().default(false),
  /** Minimum calibrated confidence required to accept a Jev answer (default: 0.8). Below it, fall through to the heuristic. */
  confidence_threshold: z.number().min(0).max(1).default(0.8),
})

export const JevIntentRoutingWireConfigSchema = z
  .object({
    /** Enable this wire (default: false). When false nothing is dispatched and no record is written. */
    enabled: z.boolean().default(false),
    /**
     * Observation-only mode (default: true). Only true is accepted: the apply path that would route a
     * turn on a Jev answer arrives with the apply phase, so false is rejected at parse time.
     */
    observe_only: z
      .boolean()
      .default(true)
      .refine((value) => value, {
        message:
          "jev.wires.intent_routing.observe_only must stay true: acting on an intent-routing prediction is not yet implemented and lands with the apply phase",
      }),
    /**
     * Minimum calibrated confidence used ONLY to label an observation record (default: 0.8).
     * This wire never gates behavior on it, so it changes the label on a record and nothing else.
     */
    confidence_threshold: z.number().min(0).max(1).default(0.8),
    /**
     * Per-decision timeout in milliseconds for this wire (default: 2500), overriding the global
     * jev.timeout_ms. W1 sends 4 questions where W4 sends 1, so tuning the global would move W4 too.
     */
    timeout_ms: z.number().int().min(100).max(30000).default(2500),
    /**
     * How long a turn record stays open for late delegations before it is sealed (default: 120000).
     * Kept separate from timeout_ms and always longer: sealing on the prediction timeout would close
     * almost every record before its first tool call.
     */
    turn_seal_timeout_ms: z.number().int().min(1000).max(600000).default(120000),
    /** Upper bound on the prompt payload in characters (default: 8000). Longer input is truncated. */
    max_prompt_chars: z.number().int().min(256).default(8000),
    /** Upper bound on concurrent in-flight dispatches (default: 8). */
    max_inflight: z.number().int().min(1).max(64).default(8),
  })
  .refine((wire) => wire.turn_seal_timeout_ms > wire.timeout_ms, {
    message:
      "jev.wires.intent_routing.turn_seal_timeout_ms must be strictly greater than timeout_ms, otherwise turns seal before their first tool call",
    path: ["turn_seal_timeout_ms"],
  })

export const JevWiresConfigSchema = z.object({
  /** Model-error triage wire (W4): retry, stop, or ignore a provider error. */
  model_error_triage: JevWireConfigSchema.default({ enabled: false, confidence_threshold: 0.8 }),
  /** Intent-routing observation wire (W1): record what Jev would have predicted for a turn. */
  intent_routing: JevIntentRoutingWireConfigSchema.default({
    enabled: false,
    observe_only: true,
    confidence_threshold: 0.8,
    timeout_ms: 2500,
    turn_seal_timeout_ms: 120000,
    max_prompt_chars: 8000,
    max_inflight: 8,
  }),
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
    intent_routing: {
      enabled: false,
      observe_only: true,
      confidence_threshold: 0.8,
      timeout_ms: 2500,
      turn_seal_timeout_ms: 120000,
      max_prompt_chars: 8000,
      max_inflight: 8,
    },
  }),
})

export type JevWireConfig = z.infer<typeof JevWireConfigSchema>
export type JevIntentRoutingWireConfig = z.infer<typeof JevIntentRoutingWireConfigSchema>
export type JevConfig = z.infer<typeof JevConfigSchema>
