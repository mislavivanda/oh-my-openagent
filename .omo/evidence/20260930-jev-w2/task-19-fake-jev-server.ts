/// <reference types="bun-types" />
import { appendFileSync, readFileSync } from "node:fs"
import { z } from "zod"

const TurnSchema = z.object({ turn: z.number(), prompt: z.string(), malformedJev: z.boolean().optional() }).catchall(z.unknown())
const port = z.coerce.number().int().positive().parse(process.env.TASK19_JEV_PORT)
const logPath = z.string().min(1).parse(process.env.TASK19_JEV_LOG)
const scriptPath = z.string().min(1).parse(process.env.TASK19_TURN_SCRIPT)
const malformedPrompts = readFileSync(scriptPath, "utf8").trim().split("\n")
  .map((line) => TurnSchema.parse(JSON.parse(line)))
  .filter((turn) => turn.malformedJev === true)
  .map((turn) => turn.prompt)
let sequence = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health") return new Response("ok")
    if (request.method !== "POST" || url.pathname !== "/v1/systemone") return Response.json({ error: { message: "not found" } }, { status: 404 })
    sequence += 1
    const body: unknown = await request.json()
    const stateText = JSON.stringify(isRecord(body) ? body.state : null)
    const malformed = malformedPrompts.some((prompt) => stateText.includes(prompt))
    appendFileSync(logPath, `${Date.now()} POST /v1/systemone sequence=${sequence} malformed=${malformed}\n`)
    if (malformed) return Response.json({ model: "jev-w2-task19", answers: { actually_complete: { type: "noul", noul: 2 } }, usage: { input_tokens: 1, output_tokens: 1 } })
    const phase = sequence % 4
    return Response.json({
      model: "jev-w2-task19",
      answers: {
        actually_complete: { type: "noul", noul: phase === 0 ? 0.94 : 0.08 },
        progressing: { type: "noul", noul: phase === 1 ? 0.93 : 0.12 },
        stuck: { type: "noul", noul: phase === 2 ? 0.91 : 0.09 },
      },
      usage: { input_tokens: 64, output_tokens: 12 },
    })
  },
})
process.stdout.write(`fake Jev ready port=${server.port}\n`)
const stop = (): void => { server.stop(true); process.exit(0) }
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
