import { appendFileSync, readFileSync } from "node:fs"

type ToolCall = {
  readonly tool: string
  readonly args: Readonly<Record<string, unknown>>
}

type Turn = {
  readonly id: string
  readonly prompt: string
  readonly calls: readonly ToolCall[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function parseCall(value: unknown, line: number): ToolCall {
  if (!isRecord(value) || typeof value.tool !== "string" || !isRecord(value.args)) {
    throw new Error(`turn script line ${line} has an invalid tool call`)
  }
  return { tool: value.tool, args: value.args }
}

function parseTurn(value: unknown, line: number): Turn {
  if (
    !isRecord(value) || typeof value.id !== "string" || typeof value.prompt !== "string" ||
    !Array.isArray(value.calls)
  ) {
    throw new Error(`turn script line ${line} has invalid model fields`)
  }
  return { id: value.id, prompt: value.prompt, calls: value.calls.map((call) => parseCall(call, line)) }
}

function loadTurns(path: string): readonly Turn[] {
  return readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0).map((line, index) => {
    const value: unknown = JSON.parse(line)
    return parseTurn(value, index + 1)
  })
}

function contentText(value: unknown): string | null {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    const chunks = value.map(contentText).filter((chunk): chunk is string => chunk !== null)
    return chunks.length > 0 ? chunks.join("") : null
  }
  if (!isRecord(value)) return null
  if (typeof value.text === "string") return value.text
  return contentText(value.content)
}

function latestUserText(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value.toReversed()) {
      const found = latestUserText(item)
      if (found !== null) return found
    }
    return null
  }
  if (!isRecord(value)) return null
  if (value.role === "user") return contentText(value.content)
  for (const key of ["input", "messages"] as const) {
    const found = latestUserText(value[key])
    if (found !== null) return found
  }
  return null
}

function usage() {
  return {
    input_tokens: 16,
    output_tokens: 6,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  }
}

function textEvents(responseID: string, text: string): readonly Record<string, unknown>[] {
  const itemID = `msg_${responseID}`
  return [
    { type: "response.created", response: { id: responseID, created_at: Math.floor(Date.now() / 1000), model: "gpt-fake" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: itemID } },
    { type: "response.output_text.delta", item_id: itemID, output_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: itemID } },
    { type: "response.completed", response: { usage: usage() } },
  ]
}

function toolEvents(responseID: string, calls: readonly ToolCall[]): readonly Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [
    { type: "response.created", response: { id: responseID, created_at: Math.floor(Date.now() / 1000), model: "gpt-fake" } },
  ]
  calls.forEach((call, index) => {
    const itemID = `fc_${responseID}_${index}`
    const callID = `call_${responseID}_${index}`
    const args = JSON.stringify(call.args)
    events.push(
      { type: "response.output_item.added", output_index: index, item: { type: "function_call", id: itemID, call_id: callID, name: call.tool, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: itemID, output_index: index, delta: args },
      { type: "response.output_item.done", output_index: index, item: { type: "function_call", id: itemID, call_id: callID, name: call.tool, arguments: args, status: "completed" } },
    )
  })
  events.push({ type: "response.completed", response: { usage: usage() } })
  return events
}

function sse(events: readonly Record<string, unknown>[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`
  return new Response(body, { headers: {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  } })
}

const port = Number(requiredEnv("TASK19_PORT"))
if (!Number.isSafeInteger(port) || port <= 0) throw new Error("TASK19_PORT must be a positive integer")
const logPath = requiredEnv("TASK19_LOG")
const turns = loadTurns(requiredEnv("TASK19_SCRIPT"))
const responseDelayMs = Number(process.env.TASK19_RESPONSE_DELAY_MS ?? "250")
if (!Number.isFinite(responseDelayMs) || responseDelayMs < 0) {
  throw new Error("TASK19_RESPONSE_DELAY_MS must be a non-negative number")
}
const issued = new Set<string>()
let requestCount = 0

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === "/health") return new Response("ok")
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: "gpt-fake", object: "model", owned_by: "task-19" }] })
    }
    if (request.method !== "POST" || url.pathname !== "/v1/responses") {
      return Response.json({ error: { message: "not found" } }, { status: 404 })
    }

    const value: unknown = await request.json()
    const userText = latestUserText(value) ?? ""
    const turn = turns.find((candidate) => userText === candidate.prompt || userText.includes(candidate.prompt))
    requestCount += 1
    const responseID = `resp_${requestCount}`
    if (turn !== undefined && turn.calls.length > 0 && !issued.has(turn.id)) {
      issued.add(turn.id)
      appendFileSync(logPath, `request=${requestCount} turn=${turn.id} mode=tools calls=${turn.calls.length}\n`)
      await Bun.sleep(responseDelayMs)
      return sse(toolEvents(responseID, turn.calls))
    }
    appendFileSync(logPath, `request=${requestCount} turn=${turn?.id ?? "child"} mode=text calls=0\n`)
    await Bun.sleep(responseDelayMs)
    return sse(textEvents(responseID, turn === undefined ? "CHILD_DONE" : `TURN_DONE_${turn.id}`))
  },
})

process.stdout.write(`fake-model listening on ${server.port}\n`)
process.on("SIGTERM", () => { server.stop(true); process.exit(0) })
process.on("SIGINT", () => { server.stop(true); process.exit(0) })
