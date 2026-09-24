import { homedir } from "node:os"
import { join } from "node:path"

import { readJevW1Corpus } from "./jev-w1-report-reader"
import { JevW1ReportIntegrityError, renderJevW1Report } from "./jev-w1-report-render"

export { JevW1ReportIntegrityError }

export function buildJevW1Report(root: string): string {
  return renderJevW1Report(readJevW1Corpus(root))
}

function rootFromArgs(args: readonly string[]): string {
  if (args.length === 0) return join(homedir(), ".omo", "jev")
  if (args.length === 2 && args[0] === "--root" && args[1] !== undefined) return args[1]
  throw new JevW1ReportIntegrityError("Usage: bun run script/jev-w1-report.ts [--root <dir>]")
}

if (import.meta.main) process.stdout.write(buildJevW1Report(rootFromArgs(process.argv.slice(2))))
