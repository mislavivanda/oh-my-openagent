import { INTENT_ROUTING_NONE_OPTION } from "./intent-routing"

/**
 * Delegation category names, copied as plain data from
 * `packages/omo-opencode/src/tools/delegate-task/{google,openai,anthropic,kimi}-categories.ts`.
 * jev-core stays harness-neutral, so the names are duplicated here rather than imported.
 */
export const INTENT_ROUTING_FIXTURE_CATEGORIES = [
  "visual-engineering",
  "ultrabrain",
  "deep",
  "artistry",
  "quick",
  "unspecified-low",
  "unspecified-high",
  "writing",
] as const

/** Coverage classes every W1 fixture corpus must exercise. */
export const INTENT_ROUTING_FIXTURE_SOURCES = [
  "NO_DELEGATION",
  "SINGLE_CATEGORY",
  "SINGLE_SUBAGENT",
  "AMBIGUOUS",
  "MULTILINGUAL",
  "CONTINUATION",
  "ADVERSARIAL",
] as const

export type IntentRoutingFixtureSource = (typeof INTENT_ROUTING_FIXTURE_SOURCES)[number]

/** Intent classes used by the hand-labeled corpus. These are fixture-only labels. */
export const INTENT_ROUTING_FIXTURE_INTENTS = [
  "implement",
  "investigate",
  "explain",
  "acknowledge",
  "continue",
  "review",
  "author",
] as const

export type IntentRoutingFixtureIntent = (typeof INTENT_ROUTING_FIXTURE_INTENTS)[number]

export type IntentRoutingFixtureLabel = {
  readonly intent: IntentRoutingFixtureIntent
  readonly category: string
  readonly subagent: string
  readonly ambiguous: boolean
}

export type IntentRoutingFixture = {
  readonly id: string
  readonly input: { readonly promptText: string }
  readonly label: IntentRoutingFixtureLabel
  readonly source: IntentRoutingFixtureSource
}

const NONE = INTENT_ROUTING_NONE_OPTION

/**
 * Hand-written, hand-labeled W1 fixtures. Every prompt is a plausible real user
 * turn and every label is a deliberate judgement, not a mechanical derivation.
 * Labels that a reviewer could reasonably dispute carry an inline note.
 */
export const INTENT_ROUTING_FIXTURES: readonly IntentRoutingFixture[] = [
  {
    id: "none-pure-question-1",
    input: { promptText: "What does the second argument of useEffect actually control?" },
    label: { intent: "explain", category: NONE, subagent: NONE, ambiguous: false },
    source: "NO_DELEGATION",
  },
  {
    id: "none-pure-explanation-1",
    input: {
      promptText:
        "Walk me through how our session compaction works at a high level. I don't need any code changes, I just want to understand the flow before our design review.",
    },
    label: { intent: "explain", category: NONE, subagent: NONE, ambiguous: false },
    source: "NO_DELEGATION",
  },
  {
    id: "none-acknowledgement-1",
    input: { promptText: "ok thanks, that makes sense" },
    label: { intent: "acknowledge", category: NONE, subagent: NONE, ambiguous: false },
    source: "NO_DELEGATION",
  },
  {
    id: "category-writing-1",
    input: {
      promptText:
        "Rewrite the README intro so a first-time user understands what this tool does in the first two sentences. Keep the install snippet exactly as it is.",
    },
    label: { intent: "author", category: "writing", subagent: NONE, ambiguous: false },
    source: "SINGLE_CATEGORY",
  },
  {
    id: "category-quick-1",
    input: { promptText: "Bump the timeout in vitest.config.ts from 5000 to 20000." },
    label: { intent: "implement", category: "quick", subagent: NONE, ambiguous: false },
    source: "SINGLE_CATEGORY",
  },
  {
    id: "subagent-explore-1",
    input: {
      promptText:
        "Where in this repo do we decide which model a background task runs on? Just find the files, don't change anything.",
    },
    label: { intent: "investigate", category: NONE, subagent: "explore", ambiguous: false },
    source: "SINGLE_SUBAGENT",
  },
  {
    id: "subagent-oracle-1",
    input: {
      promptText:
        "Review the auth middleware change I just made and tell me whether the token refresh path can ever double-write the session cookie.",
    },
    label: { intent: "review", category: NONE, subagent: "oracle", ambiguous: false },
    source: "SINGLE_SUBAGENT",
  },
  {
    // Debatable: "make it faster" could be a quick profiling pass or a deep
    // rewrite. Labelled ultrabrain because no budget or scope is given, but a
    // reviewer could defend deep or even quick here.
    id: "ambiguous-make-it-faster-1",
    input: { promptText: "this page feels slow, make it faster" },
    label: { intent: "implement", category: "ultrabrain", subagent: NONE, ambiguous: true },
    source: "AMBIGUOUS",
  },
  {
    // Debatable: "clean this up" spans formatting, dead-code removal, and
    // restructuring. The ambiguous label is the confident part; the category is not.
    id: "ambiguous-clean-up-1",
    input: { promptText: "can you clean this up a bit before I show it to the team" },
    label: { intent: "implement", category: "unspecified-low", subagent: NONE, ambiguous: true },
    source: "AMBIGUOUS",
  },
  {
    id: "multilingual-ko-1",
    input: {
      promptText:
        "로그인 실패할 때 에러 메시지가 안 뜨는데, 원인이 어디인지 코드에서 찾아줘. 고치지는 말고 위치만 알려줘.",
    },
    label: { intent: "investigate", category: NONE, subagent: "explore", ambiguous: false },
    source: "MULTILINGUAL",
  },
  {
    id: "multilingual-ja-1",
    input: {
      promptText:
        "このAPIのレスポンス型をZodスキーマに置き換えて、既存のテストが通ることを確認してください。",
    },
    label: { intent: "implement", category: "unspecified-high", subagent: NONE, ambiguous: false },
    source: "MULTILINGUAL",
  },
  {
    id: "multilingual-de-1",
    input: {
      promptText:
        "Warum schlägt der Build nur unter Windows fehl? Erklär mir bitte die Ursache, bevor wir etwas ändern.",
    },
    label: { intent: "investigate", category: NONE, subagent: "explore", ambiguous: true },
    source: "MULTILINGUAL",
  },
  {
    // KNOWN-WEAK class. No conversation history reaches the model, so the true
    // route lives entirely in the prior turn. Labelled none because a bare
    // continuation carries no routing signal on its own.
    id: "continuation-continue-1",
    input: { promptText: "continue" },
    label: { intent: "continue", category: NONE, subagent: NONE, ambiguous: true },
    source: "CONTINUATION",
  },
  {
    // KNOWN-WEAK class, same reasoning as continuation-continue-1.
    id: "continuation-go-on-1",
    input: { promptText: "go on" },
    label: { intent: "continue", category: NONE, subagent: NONE, ambiguous: true },
    source: "CONTINUATION",
  },
  {
    // Adversarial: phrased as a yes-or-no question, but the user wants the
    // migration written. Surface form says question, intent says implement.
    id: "adversarial-question-as-order-1",
    input: {
      promptText:
        "Could you maybe take a look at whether the users table needs a created_at index?",
    },
    label: { intent: "implement", category: "quick", subagent: NONE, ambiguous: true },
    source: "ADVERSARIAL",
  },
  {
    // Adversarial: imperative surface form, but the user explicitly blocks any
    // edit, so the real intent is explanation and the route is none.
    id: "adversarial-order-as-question-1",
    input: {
      promptText:
        "Refactor this into a state machine. Actually hold on, don't touch the file yet, just tell me what the states would be.",
    },
    label: { intent: "explain", category: NONE, subagent: NONE, ambiguous: false },
    source: "ADVERSARIAL",
  },
  {
    id: "category-visual-engineering-1",
    input: {
      promptText:
        "The settings modal overflows on a 1280px viewport and the footer buttons get cut off. Fix the layout and show me a screenshot.",
    },
    label: {
      intent: "implement",
      category: "visual-engineering",
      subagent: NONE,
      ambiguous: false,
    },
    source: "SINGLE_CATEGORY",
  },
]
