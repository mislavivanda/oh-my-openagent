import { z } from "zod"

export const JevWireConfigSchema = z.object({
  /** Enable this wire (default: false). When false the existing heuristic runs unchanged. */
  enabled: z.boolean().default(false),
  /** Minimum calibrated confidence required to accept a Jev answer (default: 0.8). Below it, fall through to the heuristic. */
  confidence_threshold: z.number().min(0).max(1).default(0.8),
})

export const JevIntentRoutingWireConfigSchema = z
  .object({
    /** Enable the intent-routing wire (default: false). */
    enabled: z.boolean().default(false),
    /** Keep intent routing in observation mode until the apply phase is implemented. */
    observe_only: z
      .boolean()
      .default(true)
      .refine((observeOnly) => observeOnly, {
        message: "The Jev intent-routing apply phase is not yet implemented; observe_only must remain true.",
      }),
    /** Used ONLY to label records. */
    confidence_threshold: z.number().min(0).max(1).default(0.8),
    /** Per-wire prediction timeout in milliseconds for the four intent-routing questions. */
    timeout_ms: z.number().int().min(100).max(30000).default(2500),
    /** Maximum time in milliseconds that a turn may remain open for delegations. */
    turn_seal_timeout_ms: z.number().int().min(1000).max(600000).default(120000),
    /** Maximum number of prompt characters sent to Jev. */
    max_prompt_chars: z.number().int().min(256).default(8000),
    /** Maximum number of concurrent intent-routing dispatches. */
    max_inflight: z.number().int().min(1).max(64).default(8),
  })
  .refine(({ timeout_ms, turn_seal_timeout_ms }) => turn_seal_timeout_ms > timeout_ms, {
    message: "turn_seal_timeout_ms must be strictly greater than timeout_ms",
    path: ["turn_seal_timeout_ms"],
  })

export const JevWiresConfigSchema = z.object({
  /** Model-error triage wire (W4): retry, stop, or ignore a provider error. */
  model_error_triage: JevWireConfigSchema.default({ enabled: false, confidence_threshold: 0.8 }),
  /** Intent-routing observation wire (W1). */
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
export type JevConfig = z.infer<typeof JevConfigSchema>
