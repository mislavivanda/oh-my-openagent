import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
	detectCompletionInSessionMessages,
	detectCompletionInTranscript,
} from "../../../packages/omo-opencode/src/hooks/ralph-loop/completion-promise-detector"
import {
	createPluginInput,
	type SessionMessage,
} from "../../../packages/omo-opencode/src/hooks/ralph-loop/completion-promise-detector-test-input.test"

type GoldenRow = {
	readonly name: string
	readonly detected: boolean
}

const evidenceDirectory = join(process.cwd(), ".omo/evidence/20260930-jev-w2")
const runtimeDirectory = mkdtempSync(join(evidenceDirectory, "task-9-golden-runtime-"))
let transcriptIndex = 0

function createTranscript(lines: readonly string[]): string {
	transcriptIndex += 1
	const transcriptPath = join(runtimeDirectory, `transcript-${transcriptIndex}.jsonl`)
	writeFileSync(transcriptPath, `${lines.join("\n")}\n`)
	return transcriptPath
}

async function detectSession(messages: SessionMessage[], promise: string): Promise<boolean> {
	return detectCompletionInSessionMessages(createPluginInput(messages), {
		sessionID: "task-9-golden",
		promise,
		apiTimeoutMs: 1000,
		directory: process.cwd(),
	})
}

async function collectGoldenRows(): Promise<readonly GoldenRow[]> {
	const rows: GoldenRow[] = []
	const sessionRow = async (name: string, messages: SessionMessage[], promise: string): Promise<void> => {
		rows.push({ name, detected: await detectSession(messages, promise) })
	}

	await sessionRow("plain-text-match", [
		{ info: { role: "assistant" }, parts: [{ type: "text", text: "Finished <promise>DONE</promise>" }] },
	], "DONE")
	await sessionRow("plain-text-miss", [
		{ info: { role: "assistant" }, parts: [{ type: "text", text: "Still working" }] },
	], "DONE")
	await sessionRow("oracle-tool-result", [
		{ info: { role: "assistant" }, parts: [{ type: "tool_result", text: "Agent: oracle\n<promise>VERIFIED</promise>" }] },
	], "VERIFIED")
	await sessionRow("non-oracle-tool-result", [
		{ info: { role: "assistant" }, parts: [{ type: "tool_result", text: "Agent: explore\n<promise>VERIFIED</promise>" }] },
	], "VERIFIED")
	await sessionRow("done-tool-result-excluded", [
		{ info: { role: "assistant" }, parts: [{ type: "tool_result", text: "<promise>DONE</promise>" }] },
	], "DONE")
	await sessionRow("custom-regex-literal", [
		{ info: { role: "assistant" }, parts: [{ type: "text", text: "<promise>a.c*+(x)[y]?|\\</promise>" }] },
	], "a.c*+(x)[y]?|\\")
	await sessionRow("custom-regex-not-wildcard", [
		{ info: { role: "assistant" }, parts: [{ type: "text", text: "<promise>abc</promise>" }] },
	], "a.c")
	await sessionRow("case-variation", [
		{ info: { role: "assistant" }, parts: [{ type: "text", text: "<PROMISE>done</PROMISE>" }] },
	], "DONE")
	await sessionRow("whitespace-variation", [
		{ info: { role: "assistant" }, parts: [{ type: "text", text: "<promise>\n  DONE\t </promise>" }] },
	], "DONE")

	rows.push({
		name: "old-timestamp-excluded",
		detected: detectCompletionInTranscript(createTranscript([
			JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:00.000Z", content: "<promise>DONE</promise>" }),
		]), "DONE", "2026-01-01T00:00:01.000Z"),
	})
	rows.push({
		name: "current-timestamp-included",
		detected: detectCompletionInTranscript(createTranscript([
			JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", content: "<promise>DONE</promise>" }),
		]), "DONE", "2026-01-01T00:00:00.000Z"),
	})
	rows.push({
		name: "malformed-before-valid",
		detected: detectCompletionInTranscript(createTranscript([
			"{malformed-json",
			JSON.stringify({ type: "assistant", content: "<promise>DONE</promise>" }),
		]), "DONE"),
	})
	rows.push({
		name: "malformed-only",
		detected: detectCompletionInTranscript(createTranscript(["{malformed-json"]), "DONE"),
	})
	rows.push({
		name: "user-entry-excluded",
		detected: detectCompletionInTranscript(createTranscript([
			JSON.stringify({ type: "user", content: "<promise>DONE</promise>" }),
		]), "DONE"),
	})

	return rows
}

try {
	const rows = await collectGoldenRows()
	console.log("case\tdetected")
	for (const row of rows) {
		console.log(`${row.name}\t${row.detected}`)
	}
} finally {
	rmSync(runtimeDirectory, { force: true, recursive: true })
}
