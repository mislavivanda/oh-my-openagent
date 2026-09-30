import { homedir } from "node:os"
import { join } from "node:path"
import { readIntentRoutingSink } from "../packages/omo-opencode/src/features/jev/intent-routing-reader"
import { analyzeIntentRoutingSink } from "./jev-w1-report-analysis"
import { renderIntentRoutingReport } from "./jev-w1-report-render"

class JevW1ReportArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "JevW1ReportArgumentError"
  }
}

function parseRoot(args: readonly string[]): string {
  if (args.length === 0) return join(homedir(), ".omo", "jev")
  if (args.length === 2 && args[0] === "--root" && args[1] !== "") return args[1]
  throw new JevW1ReportArgumentError("Usage: bun run script/jev-w1-report.ts [--root <dir>]")
}

export function generateIntentRoutingReport(rootDir: string): string {
  return renderIntentRoutingReport(analyzeIntentRoutingSink(readIntentRoutingSink(rootDir)))
}

export function runJevW1Report(args: readonly string[]): void {
  process.stdout.write(generateIntentRoutingReport(parseRoot(args)))
}

if (import.meta.main) runJevW1Report(process.argv.slice(2))
