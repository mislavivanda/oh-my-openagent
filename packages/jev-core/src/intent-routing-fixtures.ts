import type { IntentRoutingInput } from "./intent-routing"

export type IntentRoutingFixtureSource =
  | "NO_DELEGATION"
  | "OBVIOUS_CATEGORY"
  | "OBVIOUS_SUBAGENT"
  | "AMBIGUOUS"
  | "MULTILINGUAL"
  | "CONTINUATION"
  | "ADVERSARIAL"

export const INTENT_ROUTING_FIXTURE_SOURCES: readonly IntentRoutingFixtureSource[] = [
  "NO_DELEGATION",
  "OBVIOUS_CATEGORY",
  "OBVIOUS_SUBAGENT",
  "AMBIGUOUS",
  "MULTILINGUAL",
  "CONTINUATION",
  "ADVERSARIAL",
]

export type IntentRoutingFixtureIntent =
  | "implement"
  | "investigate"
  | "explain"
  | "review"
  | "author"
  | "acknowledge"
  | "continue"

export type IntentRoutingFixtureLabel = {
  readonly intent: IntentRoutingFixtureIntent
  readonly category: string
  readonly subagent: string
  readonly ambiguous: number
}

export type IntentRoutingFixture = {
  readonly id: string
  readonly input: IntentRoutingInput
  readonly label: IntentRoutingFixtureLabel
  readonly source: IntentRoutingFixtureSource
}

// Labels below are hand-written judgements, not derived output. They are the ground
// truth the W1 accuracy number rests on, so each one states what the router SHOULD
// answer for that turn, and `ambiguous` states how much clarification it needs first.
export const INTENT_ROUTING_FIXTURES: readonly IntentRoutingFixture[] = [
  // Pure question, pure explanation request, bare acknowledgement. No work is asked
  // for, so any delegation at all would be a false positive.
  {
    id: "no-delegation-port-question",
    input: { promptText: "Which port does the OpenCode server bind to by default?" },
    label: { intent: "explain", category: "none", subagent: "none", ambiguous: 0.05 },
    source: "NO_DELEGATION",
  },
  {
    id: "no-delegation-zod-explanation",
    input: {
      promptText:
        "Explain how a Zod discriminated union behaves at runtime compared with a plain union.",
    },
    label: { intent: "explain", category: "none", subagent: "none", ambiguous: 0.05 },
    source: "NO_DELEGATION",
  },
  {
    id: "no-delegation-acknowledgement",
    input: { promptText: "Thanks, that fixed it." },
    label: { intent: "acknowledge", category: "none", subagent: "none", ambiguous: 0.02 },
    source: "NO_DELEGATION",
  },
  // One category is plainly right and no named subagent is implied.
  {
    id: "obvious-category-modal-overflow",
    input: {
      promptText:
        "The settings modal overflows on mobile. Stack the footer buttons vertically below 480px.",
    },
    label: {
      intent: "implement",
      category: "visual-engineering",
      subagent: "none",
      ambiguous: 0.1,
    },
    source: "OBVIOUS_CATEGORY",
  },
  {
    id: "obvious-category-changelog-entry",
    input: {
      promptText: "Draft the CHANGELOG entry for the next release from these commit titles.",
    },
    label: { intent: "author", category: "writing", subagent: "none", ambiguous: 0.15 },
    source: "OBVIOUS_CATEGORY",
  },
  // One named subagent is plainly right. Category stays none so the route is single.
  {
    id: "obvious-subagent-find-callsites",
    input: {
      promptText: "Find every call site of promptAsync that bypasses the shared dispatch gate.",
    },
    label: { intent: "investigate", category: "none", subagent: "explore", ambiguous: 0.1 },
    source: "OBVIOUS_SUBAGENT",
  },
  {
    id: "obvious-subagent-flaky-race",
    input: {
      promptText:
        "This race only reproduces in CI about once every 30 runs. Reason through what could cause it.",
    },
    label: { intent: "investigate", category: "none", subagent: "oracle", ambiguous: 0.2 },
    source: "OBVIOUS_SUBAGENT",
  },
  // Genuinely underdetermined. The first has no actionable scope at all, so the correct
  // answer is to clarify rather than route. The second has a defensible small-edit
  // default while still needing confirmation.
  {
    id: "ambiguous-make-auth-better",
    input: { promptText: "Make the auth flow better." },
    label: { intent: "implement", category: "none", subagent: "none", ambiguous: 0.9 },
    source: "AMBIGUOUS",
  },
  {
    id: "ambiguous-clean-this-up",
    input: { promptText: "Clean this up." },
    label: { intent: "implement", category: "quick", subagent: "none", ambiguous: 0.8 },
    source: "AMBIGUOUS",
  },
  // Non-English turns. The routing heuristics are multilingual, so the eval set is too.
  {
    id: "multilingual-ko-profile-slow-function",
    input: { promptText: "이 함수가 왜 이렇게 느린지 프로파일링해서 근본 원인을 찾아줘." },
    label: { intent: "investigate", category: "deep", subagent: "none", ambiguous: 0.2 },
    source: "MULTILINGUAL",
  },
  {
    id: "multilingual-ja-layout-fix",
    input: {
      promptText: "このコンポーネントの余白が崩れているので、レイアウトを直してください。",
    },
    label: {
      intent: "implement",
      category: "visual-engineering",
      subagent: "none",
      ambiguous: 0.15,
    },
    source: "MULTILINGUAL",
  },
  // KNOWN-WEAK class. Only the current turn text is sent, never the conversation
  // history, so the referent is unrecoverable and no new route can be justified.
  {
    id: "continuation-continue",
    input: { promptText: "continue" },
    label: { intent: "continue", category: "none", subagent: "none", ambiguous: 0.95 },
    source: "CONTINUATION",
  },
  {
    id: "continuation-go-on",
    input: { promptText: "go on" },
    label: { intent: "continue", category: "none", subagent: "none", ambiguous: 0.95 },
    source: "CONTINUATION",
  },
  // Surface form contradicts intent. The first reads as a question but is a work order.
  // The second says "quick" while asking for a scheduler redesign.
  {
    id: "adversarial-question-shaped-work-order",
    input: { promptText: "Wouldn't it be nicer if the retry backoff were exponential?" },
    label: { intent: "implement", category: "quick", subagent: "none", ambiguous: 0.4 },
    source: "ADVERSARIAL",
  },
  {
    id: "adversarial-quick-framed-redesign",
    input: {
      promptText:
        "Just a quick one: rewrite the scheduler so long tasks can never starve short ones.",
    },
    label: { intent: "implement", category: "ultrabrain", subagent: "none", ambiguous: 0.25 },
    source: "ADVERSARIAL",
  },
]
