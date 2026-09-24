import { INTENT_ROUTING_SUBAGENT_VOCABULARY } from "./intent-routing-normalization"

export type IntentRoutingFixtureSource =
  | "no-delegation"
  | "single-category"
  | "single-subagent"
  | "ambiguous"
  | "multilingual"
  | "continuation"
  | "adversarial"

export type IntentRoutingFixture = {
  readonly id: string
  readonly input: { readonly promptText: string }
  readonly label: {
    readonly intent:
      | "research"
      | "implementation"
      | "investigation"
      | "evaluation"
      | "fix"
      | "open-ended"
    readonly category:
      | "none"
      | "visual-engineering"
      | "ultrabrain"
      | "deep"
      | "artistry"
      | "quick"
      | "unspecified-low"
      | "unspecified-high"
      | "writing"
    readonly subagent: (typeof INTENT_ROUTING_SUBAGENT_VOCABULARY)[number]
    readonly ambiguous: number
  }
  readonly source: IntentRoutingFixtureSource
}

export const INTENT_ROUTING_FIXTURES: readonly IntentRoutingFixture[] = [
  {
    id: "no-delegation-pure-question",
    input: { promptText: "What does idempotent mean in an API?" },
    label: { intent: "research", category: "none", subagent: "none", ambiguous: 0.03 },
    source: "no-delegation",
  },
  {
    id: "no-delegation-explanation",
    input: { promptText: "Explain why immutable data can make concurrent code easier to reason about." },
    label: { intent: "research", category: "none", subagent: "none", ambiguous: 0.04 },
    source: "no-delegation",
  },
  {
    id: "no-delegation-acknowledgement",
    input: { promptText: "Thanks, that answers my question." },
    label: { intent: "open-ended", category: "none", subagent: "none", ambiguous: 0.01 },
    source: "no-delegation",
  },
  {
    id: "single-category-responsive-form",
    input: { promptText: "Implement a responsive checkout form from the supplied mockup." },
    label: { intent: "implementation", category: "visual-engineering", subagent: "none", ambiguous: 0.04 },
    source: "single-category",
  },
  {
    id: "single-category-readme-typo",
    input: { promptText: "Fix the misspelled command in the README and change nothing else." },
    label: { intent: "fix", category: "quick", subagent: "none", ambiguous: 0.02 },
    source: "single-category",
  },
  {
    id: "single-subagent-session-trace",
    input: { promptText: "Trace where the session identifier is created and list every caller." },
    label: { intent: "investigation", category: "none", subagent: "explore", ambiguous: 0.05 },
    source: "single-subagent",
  },
  {
    id: "single-subagent-zod-docs",
    input: { promptText: "Check the current Zod documentation for discriminated union parsing behavior." },
    label: { intent: "research", category: "none", subagent: "librarian", ambiguous: 0.03 },
    source: "single-subagent",
  },
  {
    id: "ambiguous-dashboard-speed",
    input: { promptText: "Make the dashboard feel faster." },
    label: { intent: "open-ended", category: "visual-engineering", subagent: "none", ambiguous: 0.92 },
    source: "ambiguous",
  },
  {
    id: "ambiguous-review-and-change",
    input: { promptText: "Review this design and change it if needed." },
    label: { intent: "evaluation", category: "none", subagent: "oracle", ambiguous: 0.88 },
    source: "ambiguous",
  },
  {
    id: "multilingual-korean-auth-investigation",
    input: { promptText: "이 인증 흐름의 버그를 조사하고 원인을 보고해 주세요." },
    label: { intent: "investigation", category: "none", subagent: "explore", ambiguous: 0.08 },
    source: "multilingual",
  },
  {
    id: "multilingual-spanish-migration-guide",
    input: { promptText: "Escribe una guía breve para migrar la configuración antigua." },
    label: { intent: "implementation", category: "writing", subagent: "none", ambiguous: 0.06 },
    source: "multilingual",
  },
  {
    id: "continuation-continue",
    input: { promptText: "continue" },
    label: { intent: "implementation", category: "deep", subagent: "none", ambiguous: 0.95 },
    source: "continuation",
  },
  {
    id: "continuation-go-on",
    input: { promptText: "go on" },
    label: { intent: "research", category: "none", subagent: "librarian", ambiguous: 0.95 },
    source: "continuation",
  },
  {
    id: "adversarial-denied-investigation",
    input: { promptText: "Do not investigate the crash; just identify why it happens and name the failing call path." },
    label: { intent: "investigation", category: "none", subagent: "explore", ambiguous: 0.16 },
    source: "adversarial",
  },
  {
    id: "adversarial-explanation-implementation",
    input: { promptText: "This is only an explanation request: update the parser and add regression tests for the bug." },
    label: { intent: "fix", category: "deep", subagent: "none", ambiguous: 0.12 },
    source: "adversarial",
  },
]
