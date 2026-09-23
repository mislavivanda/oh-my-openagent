import { z } from "zod"

export const JevWireConfigSchema = z.object({
  /** Enable this wire (default: false). When false the existing heuristic runs unchanged. */
  enabled: z.boolean().default(false),
  /** Minimum calibrated confidence required to accept a Jev answer (default: 0.8). Below it, fall through to the heuristic. */
  confidence_threshold: z.number().min(0).max(1).default(0.8),
})

export const JevWiresConfigSchema = z.object({
  /** Model-error triage wire (W4): retry, stop, or ignore a provider error. */
  model_error_triage: JevWireConfigSchema.default({ enabled: false, confidence_threshold: 0.8 }),
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
  wires: JevWiresConfigSchema.default({ model_error_triage: { enabled: false, confidence_threshold: 0.8 } }),
})

export type JevWireConfig = z.infer<typeof JevWireConfigSchema>
export type JevConfig = z.infer<typeof JevConfigSchema>
