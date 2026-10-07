import type { JevCompletionContinuationClock } from "./completion-continuation"

function unsafeTestValue<TValue extends PropertyKey>(value: TValue): TValue
function unsafeTestValue<TValue>(value: unknown): TValue
function unsafeTestValue<TValue>(value: unknown): TValue {
  return value as TValue
}

export type W2HandleCategory = "backend" | "outcome" | "sink"

export type W2HandleAudit = {
  readonly category: W2HandleCategory
  readonly delayMs: number
  readonly callback: () => void
  active: boolean
  unrefCalls: number
}

export class W2HandleAuditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "W2HandleAuditError"
  }
}

export class AuditedClock implements JevCompletionContinuationClock {
  private current = 1_000_000
  readonly handles: W2HandleAudit[] = []

  constructor(
    private readonly backendTimeoutMs: number,
    private readonly omitFirstUnref = false,
  ) {}

  now = (): number => this.current

  schedule = (delayMs: number, callback: () => void) => {
    const handle: W2HandleAudit = {
      category: delayMs === this.backendTimeoutMs ? "backend" : "outcome",
      delayMs,
      callback,
      active: true,
      unrefCalls: 0,
    }
    this.handles.push(handle)
    return {
      cancel: () => { handle.active = false },
      unref: () => {
        if (this.omitFirstUnref && this.handles[0] === handle) return
        handle.unrefCalls += 1
      },
    }
  }

  fireCategory(category: W2HandleCategory): void {
    const active = this.handles.filter((handle) => handle.active && handle.category === category)
    const advance = active.reduce((maximum, handle) => Math.max(maximum, handle.delayMs), 0)
    this.current += advance
    for (const handle of active) {
      if (!handle.active) continue
      handle.active = false
      handle.callback()
    }
  }
}

export type SinkIntervalAudit = {
  readonly handle: W2HandleAudit
  restore(): void
}

type TimerInput = string | ((...args: unknown[]) => void)

export function installSinkIntervalAudit(): SinkIntervalAudit {
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  let callback: (() => void) | undefined
  const handle: W2HandleAudit = {
    category: "sink",
    delayMs: 300_000,
    callback: () => callback?.(),
    active: false,
    unrefCalls: 0,
  }
  const token = {
    unref: () => { handle.unrefCalls += 1 },
    hasRef: () => handle.unrefCalls === 0,
  }
  globalThis.setInterval = unsafeTestValue((input: TimerInput, delay?: number) => {
    if (typeof input !== "function") throw new TypeError("string intervals are unsupported")
    callback = input
    if (delay !== handle.delayMs) throw new TypeError(`unexpected sink interval delay: ${delay}`)
    handle.active = true
    return token
  })
  globalThis.clearInterval = unsafeTestValue((candidate?: ReturnType<typeof setInterval>) => {
    if (candidate === unsafeTestValue(token)) {
      handle.active = false
      return
    }
    originalClearInterval(candidate)
  })
  return {
    handle,
    restore: () => {
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
    },
  }
}

export function unrefMissing(handles: readonly W2HandleAudit[]): number {
  return handles.filter((handle) => handle.unrefCalls !== 1).length
}

export function assertW2HandleAudit(handles: readonly W2HandleAudit[]): void {
  const missing = unrefMissing(handles)
  if (missing > 0) {
    throw new W2HandleAuditError(`W2 handle unref audit failed: missing_or_duplicate=${missing}`)
  }
}

export function percentile99(samples: readonly number[]): number {
  const ordered = samples.toSorted((left, right) => left - right)
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.99) - 1)] ?? Number.POSITIVE_INFINITY
}
