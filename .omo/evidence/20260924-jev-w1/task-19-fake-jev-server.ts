import { appendFileSync } from "node:fs"

const port = Number(process.env.TASK19_JEV_PORT)
const logPath = process.env.TASK19_JEV_LOG
const pinnedModel = "jev-1.13.0"

if (!Number.isInteger(port) || port < 1 || logPath === undefined) {
  throw new Error("TASK19_JEV_PORT and TASK19_JEV_LOG are required")
}

type Question = {
  type?: unknown
  criteria?: unknown
}

function append(line: string): void {
  appendFileSync(logPath, `${line}\n`)
}

function choiceAnswer(question: Question): Record<string, unknown> {
  const criteria = question.criteria
  const labels = criteria !== null && typeof criteria === "object"
    ? Object.keys(criteria)
    : []
  const choice = labels.includes("none") ? "none" : labels[0]
  if (choice === undefined) throw new Error("choice question has no labels")
  const remainder = labels.length > 1 ? 0.1 / (labels.length - 1) : 0
  return {
    type: "choice",
    choice,
    confidence: 0.9,
    probabilities: Object.fromEntries(labels.map((label) => [label, label === choice ? 0.9 : remainder])),
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok")
    }
    if (request.method !== "POST" || url.pathname !== "/v1/systemone") {
      return Response.json({ error: { message: "not found" } }, { status: 404 })
    }

    const body: unknown = await request.json()
    const record = body !== null && typeof body === "object" ? body as Record<string, unknown> : {}
    const questions = record.questions !== null && typeof record.questions === "object"
      ? record.questions as Record<string, Question>
      : {}
    const state = record.state !== null && typeof record.state === "object"
      ? record.state as Record<string, unknown>
      : {}
    const prompt = typeof state.prompt_text === "string" ? state.prompt_text : ""
    append(JSON.stringify({ event: "systemOne", model: record.model, prompt }))

    if (prompt.includes("Repeatable prompt for completed prediction reuse.")) {
      await Bun.sleep(3_500)
    }

    const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => [
      id,
      question.type === "noul" ? { type: "noul", noul: 0.1 } : choiceAnswer(question),
    ]))
    return Response.json({
      model: pinnedModel,
      answers,
      usage: { input_tokens: 32, output_tokens: 12 },
    })
  },
})

append(JSON.stringify({ event: "started", port: server.port }))

function stop(): void {
  append(JSON.stringify({ event: "stopped" }))
  void server.stop(true).then(() => process.exit(0))
}

process.on("SIGTERM", stop)
process.on("SIGINT", stop)
