import { homedir } from "node:os"
import { join } from "node:path"
import { readCompletionContinuationSink } from "../packages/omo-opencode/src/features/jev/completion-continuation-reader"
import { analyzeCompletionContinuationSink } from "./jev-w2-report-analysis"
import { renderCompletionContinuationReport } from "./jev-w2-report-render"

class JevW2ReportArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "JevW2ReportArgumentError"
  }
}

function parseRoot(args: readonly string[]): string {
  if (args.length === 0) return join(homedir(), ".omo", "jev")
  if (args.length === 2 && args[0] === "--root" && args[1] !== "") return args[1]
  throw new JevW2ReportArgumentError("Usage: bun run script/jev-w2-report.ts [--root <dir>]")
}

export function generateCompletionContinuationReport(rootDir: string): string {
  const sink = readCompletionContinuationSink(rootDir)
  return renderCompletionContinuationReport(analyzeCompletionContinuationSink(sink))
}

export function runJevW2Report(args: readonly string[]): void {
  process.stdout.write(generateCompletionContinuationReport(parseRoot(args)))
}

if (import.meta.main) runJevW2Report(process.argv.slice(2))
