import { appendFileSync } from "node:fs"

const port = Number(process.env.TASK19_JEV_PORT)
const logPath = process.env.TASK19_JEV_LOG
const resolvedModel = "jev-1.13.0"

if (!Number.isSafeInteger(port) || port <= 0 || logPath === undefined) {
  throw new Error("TASK19_JEV_PORT and TASK19_JEV_LOG are required")
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function choiceAnswer(question: unknown, preferred: string): JsonRecord {
  const criteria = isRecord(question) && isRecord(question.criteria) ? question.criteria : {}
  const options = Object.keys(criteria)
  const choice = options.includes(preferred) ? preferred : (options[0] ?? preferred)
  const probabilities: Record<string, number> = {}
  if (options.length <= 1) {
    probabilities[choice] = 1
  } else {
    const remainder = 0.03 / (options.length - 1)
    for (const option of options) probabilities[option] = option === choice ? 0.97 : remainder
  }
  return { type: "choice", choice, probabilities, confidence: 0.97 }
}

function answerQuestions(body: unknown): JsonRecord {
  const questions = isRecord(body) && isRecord(body.questions) ? body.questions : {}
  return {
    intent: choiceAnswer(questions.intent, "implementation"),
    category: choiceAnswer(questions.category, "none"),
    subagent: choiceAnswer(questions.subagent, "none"),
    ambiguous: { type: "noul", noul: 0.08 },
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health") return new Response("ok")
    if (request.method !== "POST" || url.pathname !== "/v1/systemone") {
      return Response.json({ error: { message: "not found" } }, { status: 404 })
    }
    const body: unknown = await request.json()
    appendFileSync(logPath, `${new Date().toISOString()} POST /v1/systemone model=${isRecord(body) ? String(body.model) : "missing"}\n`)
    return Response.json({
      model: resolvedModel,
      answers: answerQuestions(body),
      usage: { input_tokens: 64, output_tokens: 16 },
    })
  },
})

process.stdout.write(`task-19 fake Jev listening on ${server.port}\n`)

function stop(): void {
  server.stop(true)
  process.exit(0)
}

process.on("SIGTERM", stop)
process.on("SIGINT", stop)
