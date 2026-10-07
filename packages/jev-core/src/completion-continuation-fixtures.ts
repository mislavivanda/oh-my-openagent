import { COMPLETION_CONTINUATION_EDGE_FIXTURES } from "./completion-continuation-fixtures-edge"
import { COMPLETION_CONTINUATION_PRIMARY_FIXTURES } from "./completion-continuation-fixtures-primary"
import type { CompletionContinuationStateInput } from "./completion-continuation-state"

export const COMPLETION_CONTINUATION_FIXTURE_COHORTS = [
  "actually-complete",
  "progressing",
  "stuck",
  "no-todos",
  "stale-todos",
  "promise-done",
  "false-promise-text",
  "continue",
  "go-on",
  "transcript-tail",
  "multilingual",
  "adversarial",
  "human-intervention",
  "slow-censored",
  "empty-transcript",
  "oversized-content",
] as const

export type CompletionContinuationFixtureCohort =
  (typeof COMPLETION_CONTINUATION_FIXTURE_COHORTS)[number]

export type CompletionContinuationFixtureTruth = boolean | "unknown"

export type CompletionContinuationFixtureLabel = {
  readonly actuallyComplete: CompletionContinuationFixtureTruth
  readonly progressing: CompletionContinuationFixtureTruth
  readonly stuck: CompletionContinuationFixtureTruth
}

export type CompletionContinuationFixture = {
  readonly id: string
  readonly input: CompletionContinuationStateInput
  readonly label: CompletionContinuationFixtureLabel
  readonly cohorts: readonly CompletionContinuationFixtureCohort[]
  readonly groundTruthSource: "hand-assigned"
  readonly labelBasis: string
}

export const COMPLETION_CONTINUATION_FIXTURES: readonly CompletionContinuationFixture[] = [
  ...COMPLETION_CONTINUATION_PRIMARY_FIXTURES,
  ...COMPLETION_CONTINUATION_EDGE_FIXTURES,
]
