import { appendFileSync, readFileSync } from "node:fs"

type ToolCall = Readonly<{
  tool: string
  args: Readonly<Record<string, unknown>>
}>

type TurnScript = Readonly<{
  prompt: string
  calls: readonly ToolCall[]
}>

const port = Number(process.env.TASK19_MODEL_PORT)
const logPath = process.env.TASK19_MODEL_LOG
const scriptPath = process.env.TASK19_TURN_SCRIPT

if (!Number.isInteger(port) || port < 1 || logPath === undefined || scriptPath === undefined) {
  throw new Error("TASK19_MODEL_PORT, TASK19_MODEL_LOG, and TASK19_TURN_SCRIPT are required")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function parseTurn(value: unknown): TurnScript {
  if (!isRecord(value) || typeof value.prompt !== "string" || !Array.isArray(value.calls)) {
    throw new Error("invalid turn script entry")
  }
  const calls = value.calls.map((candidate): ToolCall => {
    if (!isRecord(candidate) || typeof candidate.tool !== "string" || !isRecord(candidate.args)) {
      throw new Error("invalid scripted tool call")
    }
    return { tool: candidate.tool, args: candidate.args }
  })
  return { prompt: value.prompt, calls }
}

const turns = readFileSync(scriptPath, "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => parseTurn(JSON.parse(line)))

let callCount = 0

function append(line: string): void {
  appendFileSync(logPath, `${line}\n`)
}

function sendEvents(events: readonly Record<string, unknown>[]): Response {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`
  return new Response(body, {
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream; charset=utf-8",
    },
  })
}

function usage(): Record<string, unknown> {
  return {
    input_tokens: 20,
    output_tokens: 8,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  }
}

function textEvents(id: number, text: string): readonly Record<string, unknown>[] {
  const responseID = `resp_${id}`
  const itemID = `msg_${id}`
  return [
    { type: "response.created", response: { id: responseID, created_at: Math.floor(Date.now() / 1000), model: "gpt-fake" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: itemID } },
    { type: "response.output_text.delta", item_id: itemID, output_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: itemID } },
    { type: "response.completed", response: { usage: usage() } },
  ]
}

function toolEvents(id: number, calls: readonly ToolCall[]): readonly Record<string, unknown>[] {
  const responseID = `resp_${id}`
  const events: Record<string, unknown>[] = [
    { type: "response.created", response: { id: responseID, created_at: Math.floor(Date.now() / 1000), model: "gpt-fake" } },
  ]
  calls.forEach((call, index) => {
    const itemID = `fc_${id}_${index}`
    const callID = `call_${id}_${index}`
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

function itemText(item: Record<string, unknown>): string {
  if (typeof item.content === "string") return item.content
  if (!Array.isArray(item.content)) return ""
  return item.content
    .filter(isRecord)
    .map((content) => typeof content.text === "string" ? content.text : "")
    .join("\n")
}

function currentUserInput(body: unknown): Readonly<{ text: string; trailing: readonly unknown[] }> | undefined {
  if (!isRecord(body) || !Array.isArray(body.input)) return undefined
  for (let index = body.input.length - 1; index >= 0; index -= 1) {
    const item = body.input[index]
    if (!isRecord(item) || item.role !== "user") continue
    const text = itemText(item)
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
      .trim()
    if (text.length === 0 || text.startsWith("[SYSTEM DIRECTIVE: OH-MY-OPENCODE")) continue
    return { text, trailing: body.input.slice(index + 1) }
  }
  return undefined
}

function selectTurn(userText: string): TurnScript | undefined {
  let selected: TurnScript | undefined
  for (const turn of turns) {
    if (userText.includes(turn.prompt) && (selected === undefined || turn.prompt.length > selected.prompt.length)) {
      selected = turn
    }
  }
  return selected
}

function hasToolResult(items: readonly unknown[]): boolean {
  return items.some((item) => isRecord(item) && (item.type === "function_call_output" || item.role === "tool"))
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

    callCount += 1
    const body: unknown = await request.json()
    const bodyText = JSON.stringify(body)
    if (bodyText.includes("Generate a title")) {
      append(JSON.stringify({ event: "title", call: callCount }))
      return sendEvents(textEvents(callCount, "task 19 dogfood"))
    }
    const current = currentUserInput(body)
    const turn = current === undefined ? undefined : selectTurn(current.text)
    if (current === undefined || turn === undefined) {
      append(JSON.stringify({ event: "child_or_default", call: callCount }))
      return sendEvents(textEvents(callCount, "DONE"))
    }

    const resultPresent = hasToolResult(current.trailing)
    append(JSON.stringify({
      event: resultPresent || turn.calls.length === 0 ? "text" : "tool_calls",
      call: callCount,
      prompt: turn.prompt,
      tools: turn.calls.map((call) => call.tool),
      userHead: current.text.slice(0, 240),
    }))
    return resultPresent || turn.calls.length === 0
      ? sendEvents(textEvents(callCount, "TURN_DONE"))
      : sendEvents(toolEvents(callCount, turn.calls))
  },
})

append(JSON.stringify({ event: "started", port: server.port, turns: turns.length }))

function stop(): void {
  append(JSON.stringify({ event: "stopped", calls: callCount }))
  void server.stop(true).then(() => process.exit(0))
}

process.on("SIGTERM", stop)
process.on("SIGINT", stop)
