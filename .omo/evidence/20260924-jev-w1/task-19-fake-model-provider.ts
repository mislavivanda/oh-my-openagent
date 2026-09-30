import { appendFileSync, readFileSync } from "node:fs"

type ToolCall = {
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
}

type Turn = {
  readonly turn: number
  readonly prompt: string
  readonly tools: readonly ToolCall[]
}

const port = Number(process.env.TASK19_MODEL_PORT)
const logPath = process.env.TASK19_MODEL_LOG
const scriptPath = process.env.TASK19_TURN_SCRIPT

if (!Number.isSafeInteger(port) || port <= 0 || logPath === undefined || scriptPath === undefined) {
  throw new Error("TASK19_MODEL_PORT, TASK19_MODEL_LOG, and TASK19_TURN_SCRIPT are required")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseTool(value: unknown): ToolCall {
  if (!isRecord(value) || typeof value.name !== "string" || !isRecord(value.args)) {
    throw new TypeError("Invalid tool call in task-19 turn script")
  }
  return { name: value.name, args: value.args }
}

function parseTurn(line: string): Turn {
  const value: unknown = JSON.parse(line)
  if (!isRecord(value) || typeof value.turn !== "number" || !Number.isSafeInteger(value.turn) || typeof value.prompt !== "string" || !Array.isArray(value.tools)) {
    throw new TypeError("Invalid task-19 turn script line")
  }
  return { turn: value.turn, prompt: value.prompt, tools: value.tools.map(parseTool) }
}

const turns = readFileSync(scriptPath, "utf8").trim().split("\n").filter(Boolean).map(parseTurn)
const nextToolIndex = new Map<number, number>()
let requestSequence = 0

function responseEvents(turn: Turn | undefined): string {
  requestSequence += 1
  const responseId = `resp_task19_${requestSequence}`
  const events: unknown[] = [{
    type: "response.created",
    response: { id: responseId, created_at: Math.floor(Date.now() / 1000), model: "gpt-task19" },
  }]
  const toolIndex = turn === undefined ? 0 : (nextToolIndex.get(turn.turn) ?? 0)
  const tool = turn?.tools[toolIndex]
  if (turn !== undefined && tool !== undefined) {
    nextToolIndex.set(turn.turn, toolIndex + 1)
    const itemId = `fc_task19_${requestSequence}_${toolIndex}`
    const callId = `call_task19_${turn.turn}_${toolIndex}`
    const emittedArgs = tool.name === "task"
      ? { ...tool.args, run_in_background: true }
      : tool.args
    const args = JSON.stringify(emittedArgs)
    events.push({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: itemId, call_id: callId, name: tool.name, arguments: "" },
    }, {
      type: "response.function_call_arguments.delta",
      item_id: itemId,
      output_index: 0,
      delta: args,
    }, {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "function_call", id: itemId, call_id: callId, name: tool.name, arguments: args, status: "completed" },
    })
  } else {
    const itemId = `msg_task19_${requestSequence}`
    const text = turn === undefined ? "TASK19_CHILD_OK" : `TASK19_TURN_${turn.turn}_OK`
    events.push({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: itemId },
    }, {
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: 0,
      delta: text,
    }, {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: itemId },
    })
  }
  events.push({
    type: "response.completed",
    response: {
      id: responseId,
      model: "gpt-task19",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  })
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`
}

function matchingTurn(bodyText: string): Turn | undefined {
  let match: Turn | undefined
  let matchIndex = -1
  for (const turn of turns) {
    const index = bodyText.lastIndexOf(turn.prompt)
    if (index >= matchIndex && index >= 0) {
      match = turn
      matchIndex = index
    }
  }
  return match
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health") return new Response("ok")
    if (request.method !== "POST" || !url.pathname.endsWith("/responses")) {
      return Response.json({ error: { message: "not found" } }, { status: 404 })
    }
    const bodyText = await request.text()
    const turn = matchingTurn(bodyText)
    const toolIndex = turn === undefined ? 0 : (nextToolIndex.get(turn.turn) ?? 0)
    appendFileSync(logPath, `${new Date().toISOString()} request=${requestSequence + 1} turn=${turn?.turn ?? "child"} tool_index=${toolIndex}\n`)
    return new Response(responseEvents(turn), {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    })
  },
})

process.stdout.write(`task-19 fake model listening on ${server.port}\n`)

function stop(): void {
  server.stop(true)
  process.exit(0)
}

process.on("SIGTERM", stop)
process.on("SIGINT", stop)
