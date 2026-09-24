import { appendFileSync, readFileSync } from "node:fs"

type Prediction = {
  readonly intent: string
  readonly category: string
  readonly subagent: string
  readonly ambiguous: number
}

type Turn = {
  readonly id: string
  readonly prompt: string
  readonly prediction: Prediction
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function parseTurn(value: unknown, line: number): Turn {
  if (!isRecord(value) || !isRecord(value.prediction)) {
    throw new Error(`turn script line ${line} is not an object with prediction`)
  }
  const { id, prompt, prediction } = value
  if (
    typeof id !== "string" || typeof prompt !== "string" ||
    typeof prediction.intent !== "string" || typeof prediction.category !== "string" ||
    typeof prediction.subagent !== "string" || typeof prediction.ambiguous !== "number"
  ) {
    throw new Error(`turn script line ${line} has invalid prediction fields`)
  }
  return { id, prompt, prediction: {
    intent: prediction.intent,
    category: prediction.category,
    subagent: prediction.subagent,
    ambiguous: prediction.ambiguous,
  } }
}

function loadTurns(path: string): readonly Turn[] {
  return readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0).map((line, index) => {
    const value: unknown = JSON.parse(line)
    return parseTurn(value, index + 1)
  })
}

function promptFromBody(body: Record<string, unknown>): string {
  const state = body.state
  return isRecord(state) && typeof state.promptText === "string" ? state.promptText : ""
}

function selectedChoice(questionID: string, turn: Turn | undefined): string | undefined {
  if (turn === undefined) return undefined
  switch (questionID) {
    case "intent": return turn.prediction.intent
    case "category": return turn.prediction.category
    case "subagent": return turn.prediction.subagent
    default: return undefined
  }
}

function choiceAnswer(questionID: string, question: Record<string, unknown>, turn: Turn | undefined) {
  const criteria = isRecord(question.criteria) ? question.criteria : {}
  const choices = Object.keys(criteria)
  const requested = selectedChoice(questionID, turn)
  const choice = requested !== undefined && choices.includes(requested) ? requested : choices[0]
  if (choice === undefined) throw new Error(`choice question ${questionID} has no criteria`)
  const remainder = choices.length > 1 ? 0.06 / (choices.length - 1) : 0
  return {
    type: "choice",
    choice,
    probabilities: Object.fromEntries(choices.map((key) => [key, key === choice ? (choices.length === 1 ? 1 : 0.94) : remainder])),
    confidence: choices.length === 1 ? 1 : 0.94,
  }
}

const port = Number(requiredEnv("TASK19_PORT"))
if (!Number.isSafeInteger(port) || port <= 0) throw new Error("TASK19_PORT must be a positive integer")
const logPath = requiredEnv("TASK19_LOG")
const pinnedModel = requiredEnv("TASK19_PINNED_MODEL")
const turns = loadTurns(requiredEnv("TASK19_SCRIPT"))
const byPrompt = new Map(turns.map((turn) => [turn.prompt, turn]))
let requestCount = 0

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health") return new Response("ok")
    if (request.method !== "POST" || url.pathname !== "/v1/systemone") {
      return Response.json({ error: { message: "not found" } }, { status: 404 })
    }

    const value: unknown = await request.json()
    if (!isRecord(value) || !isRecord(value.questions)) {
      return Response.json({ error: { message: "invalid request" } }, { status: 400 })
    }
    const prompt = promptFromBody(value)
    const turn = byPrompt.get(prompt)
    const answers: Record<string, unknown> = {}
    for (const [questionID, rawQuestion] of Object.entries(value.questions)) {
      if (!isRecord(rawQuestion) || typeof rawQuestion.type !== "string") {
        return Response.json({ error: { message: `invalid question ${questionID}` } }, { status: 400 })
      }
      switch (rawQuestion.type) {
        case "choice": answers[questionID] = choiceAnswer(questionID, rawQuestion, turn); break
        case "noul": answers[questionID] = { type: "noul", noul: turn?.prediction.ambiguous ?? 0.05 }; break
        default: return Response.json({ error: { message: `unsupported question ${questionID}` } }, { status: 400 })
      }
    }
    requestCount += 1
    appendFileSync(logPath, `request=${requestCount} turn=${turn?.id ?? "unknown"}\n`)
    return Response.json({
      model: pinnedModel,
      answers,
      usage: { input_tokens: 24, output_tokens: 8 },
    })
  },
})

process.stdout.write(`fake-jev listening on ${server.port}\n`)
process.on("SIGTERM", () => { server.stop(true); process.exit(0) })
process.on("SIGINT", () => { server.stop(true); process.exit(0) })
