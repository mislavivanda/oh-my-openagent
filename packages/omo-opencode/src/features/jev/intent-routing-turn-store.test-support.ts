import type {
  IntentRoutingDecisionResult,
  IntentRoutingObservedDelegation,
} from "@oh-my-opencode/jev-core"

export const PINNED_MODEL = "jev-1.13.0"
export const FLOATING_MODEL = "jev-latest"

export function filledResult(
  resolvedModel = PINNED_MODEL,
  category = "deep",
): IntentRoutingDecisionResult {
  const wouldApply = "would_apply" as const
  return {
    predictionStatus: "filled",
    unavailableReason: null,
    resolvedModel,
    latencyMs: 12,
    answers: {
      intent: {
        choice: "delegate",
        confidence: 0.95,
        probabilities: { delegate: 0.95, act: 0.05 },
        valid: true,
        label: wouldApply,
      },
      category: {
        choice: category,
        confidence: 0.91,
        probabilities: { [category]: 0.91, none: 0.09 },
        valid: true,
        label: wouldApply,
      },
      subagent: {
        choice: "none",
        confidence: 0.93,
        probabilities: { none: 0.93, explore: 0.07 },
        valid: true,
        label: wouldApply,
      },
      ambiguous: { noul: 0.1, valid: true },
    },
    invalidAnswerCount: 0,
    truncatedInput: false,
    threshold: 0.8,
    questionVersion: 1,
  }
}

export function failedResult(): IntentRoutingDecisionResult {
  const wouldFallThrough = "would_fall_through" as const
  const emptyChoice = {
    choice: null,
    confidence: null,
    probabilities: null,
    valid: false,
    label: wouldFallThrough,
  }
  return {
    predictionStatus: "failed",
    unavailableReason: "transport_error",
    resolvedModel: null,
    latencyMs: 8,
    answers: {
      intent: emptyChoice,
      category: emptyChoice,
      subagent: emptyChoice,
      ambiguous: { noul: null, valid: false },
    },
    invalidAnswerCount: 0,
    truncatedInput: false,
    threshold: 0.8,
    questionVersion: 1,
  }
}

export function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolveValue = (_value: T): void => {
    throw new TypeError("deferred promise was not initialized")
  }
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve
  })
  return { promise, resolve: resolveValue }
}

export function textParts(
  text: string,
): readonly { readonly type: "text"; readonly text: string }[] {
  return [{ type: "text", text }]
}

export function baseTurn(
  sessionID: string,
  text: string,
  dispatch?: () => Promise<IntentRoutingDecisionResult>,
) {
  return {
    sessionID,
    parts: textParts(text),
    questionVersion: 1,
    vocabularyDigest: "vocab-a",
    confidenceThreshold: 0.8,
    configuredModelSpec: PINNED_MODEL,
    dispatch,
  }
}

export function observation(callID = "call-1"): IntentRoutingObservedDelegation {
  return {
    tool: "task",
    category: "deep",
    subagentType: null,
    requestedSubagentType: null,
    taskId: null,
    normalizedCategory: "deep",
    normalizedSubagent: "none",
    routeClass: "category",
    callID,
  }
}
