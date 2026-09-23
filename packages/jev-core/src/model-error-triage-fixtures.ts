import type { ModelErrorTriageChoice, ModelErrorTriageInput } from "./model-error-triage"

export type ModelErrorTriageFixtureSource =
  | "RETRYABLE_ERROR_NAMES"
  | "STOP_ERROR_NAMES"
  | "NON_RETRYABLE_ERROR_NAMES"
  | "RETRYABLE_MESSAGE_PATTERNS"
  | "STOP_MESSAGE_PATTERNS"
  | "AUTO_RETRY_GATE"
  | "STATUS_CODE"
  | "UNKNOWN"

export const MODEL_ERROR_TRIAGE_FIXTURE_LABEL_BY_SOURCE: Record<
  ModelErrorTriageFixtureSource,
  ModelErrorTriageChoice
> = {
  RETRYABLE_ERROR_NAMES: "retry",
  STOP_ERROR_NAMES: "stop",
  NON_RETRYABLE_ERROR_NAMES: "ignore",
  RETRYABLE_MESSAGE_PATTERNS: "retry",
  STOP_MESSAGE_PATTERNS: "stop",
  AUTO_RETRY_GATE: "retry",
  STATUS_CODE: "retry",
  UNKNOWN: "ignore",
}

export type ModelErrorTriageFixture = {
  readonly id: string
  readonly input: ModelErrorTriageInput
  readonly heuristicShouldRetry: boolean
  readonly label: ModelErrorTriageChoice
  readonly source: ModelErrorTriageFixtureSource
}

const RETRYABLE_ERROR_NAMES = [
  "providermodelnotfounderror",
  "ratelimiterror",
  "modelunavailableerror",
  "providerconnectionerror",
  "authenticationerror",
] as const

const STOP_ERROR_NAMES = [
  "quotaexceedederror",
  "insufficientcreditserror",
  "freeusagelimiterror",
] as const

const NON_RETRYABLE_ERROR_NAMES = [
  "messageabortederror",
  "permissiondeniederror",
  "contextlengtherror",
  "timeouterror",
  "validationerror",
  "syntaxerror",
  "usererror",
] as const

const RETRYABLE_MESSAGE_PATTERNS = [
  "rate_limit",
  "rate limit",
  "usage_limit_reached",
  "usage limit has been reached",
  "quota",
  "all credentials for model",
  "cooling down",
  "not found",
  "unavailable",
  "insufficient",
  "too many requests",
  "over limit",
  "overloaded",
  "bad gateway",
  "bad request",
  "unknown provider",
  "provider not found",
  "model_not_supported",
  "model not supported",
  "model is not supported",
  "connection error",
  "network error",
  "timeout",
  "service unavailable",
  "internal_server_error",
  "free usage",
  "usage exceeded",
  "credit",
  "balance",
  "temporarily unavailable",
  "try again",
  "请稍后重试",
  "503",
  "502",
  "504",
  "429",
  "529",
  "selected provider is forbidden",
  "provider is forbidden",
  "频率限制",
  "请求过于频繁",
  "暂时不可用",
  "服务不可用",
  "server_error",
  "an error occurred while processing",
] as const

const STOP_MESSAGE_PATTERNS = [
  "quota will reset after",
  "quota exceeded",
  "free usage limit",
  "billing limit",
  "billing hard limit",
  "monthly limit",
  "plan limit",
  "subscription quota",
  "subscription limit",
  "payment required",
  "out of credits",
  "credits exhausted",
  "insufficient credits",
  "insufficient balance",
  "credit balance",
  "usage limit for this month",
  "exhausted your capacity",
  "daily call limit",
  "daily limit",
  "usage limit reached for",
  "in arrears",
  "fair use policy",
  "recharge and try",
  "使用上限",
  "额度不足",
  "余额不足",
  "已耗尽",
] as const

function createNameFixtures(
  source: ModelErrorTriageFixtureSource,
  names: readonly string[],
  heuristicShouldRetry: boolean,
): readonly ModelErrorTriageFixture[] {
  return names.map((name, index) => ({
    id: `${source.toLowerCase()}-${index + 1}`,
    input: { name },
    heuristicShouldRetry,
    label: MODEL_ERROR_TRIAGE_FIXTURE_LABEL_BY_SOURCE[source],
    source,
  }))
}

function createMessageFixtures(
  source: ModelErrorTriageFixtureSource,
  messages: readonly string[],
  heuristicShouldRetry: boolean,
): readonly ModelErrorTriageFixture[] {
  return messages.map((message, index) => ({
    id: `${source.toLowerCase()}-${index + 1}`,
    input: { message },
    heuristicShouldRetry,
    label: MODEL_ERROR_TRIAGE_FIXTURE_LABEL_BY_SOURCE[source],
    source,
  }))
}

export const MODEL_ERROR_TRIAGE_FIXTURES: readonly ModelErrorTriageFixture[] = [
  ...createNameFixtures("RETRYABLE_ERROR_NAMES", RETRYABLE_ERROR_NAMES, true),
  ...createNameFixtures("STOP_ERROR_NAMES", STOP_ERROR_NAMES, false),
  ...createNameFixtures("NON_RETRYABLE_ERROR_NAMES", NON_RETRYABLE_ERROR_NAMES, false),
  ...createMessageFixtures(
    "RETRYABLE_MESSAGE_PATTERNS",
    RETRYABLE_MESSAGE_PATTERNS,
    true,
  ),
  ...createMessageFixtures("STOP_MESSAGE_PATTERNS", STOP_MESSAGE_PATTERNS, false),
  {
    id: "auto_retry_gate-1",
    input: { message: "rate limit exceeded, retrying in 3s" },
    heuristicShouldRetry: true,
    label: MODEL_ERROR_TRIAGE_FIXTURE_LABEL_BY_SOURCE.AUTO_RETRY_GATE,
    source: "AUTO_RETRY_GATE",
  },
  ...([429, 503, 529] as const).map((statusCode, index) => ({
    id: `status_code-${index + 1}`,
    input: { statusCode, message: "provider rejected request without details" },
    heuristicShouldRetry: true,
    label: MODEL_ERROR_TRIAGE_FIXTURE_LABEL_BY_SOURCE.STATUS_CODE,
    source: "STATUS_CODE" as const,
  })),
  ...createMessageFixtures(
    "UNKNOWN",
    [
      "permission denied while opening a local file",
      "context length exceeded by the request",
      "invalid json syntax in tool arguments",
    ],
    false,
  ),
]
