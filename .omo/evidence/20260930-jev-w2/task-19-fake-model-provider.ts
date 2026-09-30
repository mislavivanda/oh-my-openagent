/// <reference types="bun-types" />
import { appendFileSync, readFileSync } from "node:fs"
import { z } from "zod"

const ToolSchema = z.object({ name: z.string(), args: z.record(z.string(), z.unknown()) })
const TurnSchema = z.object({
  turn: z.number().int().positive(),
  prompt: z.string(),
  tools: z.array(ToolSchema),
  response: z.string(),
  action: z.string().optional(),
  malformedJev: z.boolean().optional(),
})
type Turn = z.infer<typeof TurnSchema>

const port = z.coerce.number().int().positive().parse(process.env.TASK19_MODEL_PORT)
const logPath = z.string().min(1).parse(process.env.TASK19_MODEL_LOG)
const scriptPath = z.string().min(1).parse(process.env.TASK19_TURN_SCRIPT)
const workDir = z.string().min(1).parse(process.env.TASK19_WORK_DIR)
const turns = readFileSync(scriptPath, "utf8").trim().split("\n")
  .map((line) => TurnSchema.parse(JSON.parse(line)))
const nextToolIndex = new Map<number, number>()
let requestSequence = 0

function matchingTurn(bodyText: string): Turn | undefined {
  let match: Turn | undefined
  let matchIndex = -1
  for (const turn of turns) {
    const index = bodyText.lastIndexOf(turn.prompt)
    if (index >= 0 && index >= matchIndex) {
      match = turn
      matchIndex = index
    }
  }
  if (match === undefined && bodyText.includes("[W2-DISPOSE]")) {
    return TurnSchema.parse({
      turn: 1000,
      prompt: "[W2-DISPOSE]",
      tools: [{ name: "todowrite", args: { todos: [{ content: "Dispose censor work", status: "in_progress", priority: "high" }] } }],
      response: "Pending for dispose.",
    })
  }
  if (match === undefined) {
    const eviction = bodyText.match(/\[W2-EVICT-(\d+)\]/)
    if (eviction?.[1] !== undefined) {
      const index = Number(eviction[1])
      return TurnSchema.parse({
        turn: 2000 + index,
        prompt: `[W2-EVICT-${index}]`,
        tools: [{ name: "todowrite", args: { todos: [{ content: `Eviction work ${index}`, status: "in_progress", priority: "high" }] } }],
        response: "Pending eviction work.",
      })
    }
  }
  return match
}

function responseEvents(turn: Turn | undefined): string {
  requestSequence += 1
  const responseId = `resp_w2_${requestSequence}`
  const events: unknown[] = [{
    type: "response.created",
    response: { id: responseId, created_at: Math.floor(Date.now() / 1000), model: "gpt-w2-task19" },
  }]
  const toolIndex = turn === undefined ? 0 : (nextToolIndex.get(turn.turn) ?? 0)
  const tool = turn?.tools[toolIndex]
  if (turn !== undefined && tool !== undefined) {
    nextToolIndex.set(turn.turn, toolIndex + 1)
    const itemId = `fc_w2_${requestSequence}_${toolIndex}`
    const args = JSON.stringify(Object.fromEntries(Object.entries(tool.args).map(([key, value]) => [
      key,
      typeof value === "string" ? value.replaceAll("__TASK19_WORK__", workDir) : value,
    ])))
    events.push(
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: itemId, call_id: itemId, name: tool.name, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: itemId, output_index: 0, delta: args },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: itemId, call_id: itemId, name: tool.name, arguments: args, status: "completed" } },
    )
  } else {
    const text = turn?.response ?? "Internal continuation acknowledged."
    const itemId = `msg_w2_${requestSequence}`
    events.push(
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: itemId } },
      { type: "response.output_text.delta", item_id: itemId, output_index: 0, delta: text },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: itemId } },
    )
  }
  events.push({ type: "response.completed", response: { id: responseId, model: "gpt-w2-task19", usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health") return new Response("ok")
    if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return Response.json({ error: { message: "not found" } }, { status: 404 })
    const bodyText = await request.text()
    const turn = matchingTurn(bodyText)
    appendFileSync(logPath, `${Date.now()} request=${requestSequence + 1} turn=${turn?.turn ?? "internal"}\n`)
    return new Response(responseEvents(turn), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } })
  },
})
process.stdout.write(`fake model ready port=${server.port}\n`)
const stop = (): void => { server.stop(true); process.exit(0) }
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
