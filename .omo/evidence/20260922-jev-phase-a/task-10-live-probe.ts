import {
  MODEL_ERROR_TRIAGE_FIXTURES,
  MODEL_ERROR_TRIAGE_QUESTIONS,
  buildModelErrorTriageState,
  createRealDecisionBackend,
  type ModelErrorTriageFixture,
} from "@oh-my-opencode/jev-core"

const retryFixture = MODEL_ERROR_TRIAGE_FIXTURES.find(
  ({ id }) => id === "retryable_message_patterns-1",
)
const stopFixture = MODEL_ERROR_TRIAGE_FIXTURES.find(
  ({ id }) => id === "stop_message_patterns-2",
)
const ignoreFixture = MODEL_ERROR_TRIAGE_FIXTURES.find(
  ({ id }) => id === "non_retryable_error_names-1",
)

if (retryFixture === undefined || stopFixture === undefined || ignoreFixture === undefined) {
  throw new Error("Live-probe fixtures are missing")
}

const backend = createRealDecisionBackend({
  apiKey: process.env.TYPESAFE_API_KEY,
  model: "jev-latest",
  timeoutMs: 5000,
})

async function printDecision(fixture: ModelErrorTriageFixture): Promise<void> {
  const outcome = await backend.decide({
    state: buildModelErrorTriageState(fixture.input),
    questions: MODEL_ERROR_TRIAGE_QUESTIONS,
  })

  if (outcome.status === "decided") {
    const answer = outcome.answers.triage
    console.log(
      JSON.stringify({
        id: fixture.id,
        label: fixture.label,
        status: outcome.status,
        choice: answer.choice,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
        model: outcome.model,
        latencyMs: outcome.latencyMs,
        reason: null,
      }),
    )
    return
  }

  console.log(
    JSON.stringify({
      id: fixture.id,
      label: fixture.label,
      status: outcome.status,
      choice: null,
      confidence: null,
      probabilities: null,
      model: null,
      latencyMs: outcome.latencyMs,
      reason: outcome.reason,
    }),
  )
}

await printDecision(retryFixture)
await printDecision(stopFixture)
await printDecision(ignoreFixture)
