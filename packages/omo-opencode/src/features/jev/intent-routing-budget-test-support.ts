import { dlopen, FFIType } from "bun:ffi"

export const INTENT_ROUTING_BUDGET_SAMPLE_COUNT = 200
export const INTENT_ROUTING_CPU_P99_BOUND_US = 1_000

export type IntentRoutingBudgetP99 = {
  readonly cpuP99Us: number
  readonly sampleCount: number
  readonly wallP99Ms: number
}

type ThreadCpuClock = {
  readonly close: () => void
  readonly nowNanoseconds: () => bigint
}

class ThreadCpuClockError extends Error {
  constructor(readonly operation: string) {
    super(`thread CPU clock operation failed: ${operation}`)
    this.name = "ThreadCpuClockError"
  }
}

function createPosixThreadCpuClock(): ThreadCpuClock {
  const library = dlopen(
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
    {
      clock_gettime: {
        args: [FFIType.i32, FFIType.ptr],
        returns: FFIType.i32,
      },
    },
  )
  const clockID = process.platform === "darwin" ? 16 : 3
  const timespec = new BigInt64Array(2)

  return {
    close: library.close,
    nowNanoseconds: () => {
      if (library.symbols.clock_gettime(clockID, timespec) !== 0) {
        throw new ThreadCpuClockError("clock_gettime")
      }
      return timespec[0] * 1_000_000_000n + timespec[1]
    },
  }
}

function createWindowsThreadCpuClock(): ThreadCpuClock {
  const library = dlopen("kernel32.dll", {
    GetCurrentThread: { args: [], returns: FFIType.u64 },
    GetThreadTimes: {
      args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.bool,
    },
  })
  const threadHandle = library.symbols.GetCurrentThread()
  const creationTime = new BigUint64Array(1)
  const exitTime = new BigUint64Array(1)
  const kernelTime = new BigUint64Array(1)
  const userTime = new BigUint64Array(1)

  return {
    close: library.close,
    nowNanoseconds: () => {
      const succeeded = library.symbols.GetThreadTimes(
        threadHandle,
        creationTime,
        exitTime,
        kernelTime,
        userTime,
      )
      if (!succeeded) throw new ThreadCpuClockError("GetThreadTimes")
      return (kernelTime[0] + userTime[0]) * 100n
    },
  }
}

function createThreadCpuClock(): ThreadCpuClock {
  return process.platform === "win32"
    ? createWindowsThreadCpuClock()
    : createPosixThreadCpuClock()
}

function p99(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * 0.99) - 1] ?? Number.POSITIVE_INFINITY
}

export function measureIntentRoutingSynchronousP99(
  runSynchronousSeam: () => void,
): IntentRoutingBudgetP99 {
  const cpuSamplesUs: number[] = []
  const wallSamplesMs: number[] = []
  const threadCpuClock = createThreadCpuClock()

  try {
    for (let index = 0; index < INTENT_ROUTING_BUDGET_SAMPLE_COUNT; index += 1) {
      const cpuStartedAt = threadCpuClock.nowNanoseconds()
      const wallStartedAt = performance.now()
      runSynchronousSeam()
      const wallElapsedMs = performance.now() - wallStartedAt
      const cpuElapsedUs = Number(threadCpuClock.nowNanoseconds() - cpuStartedAt) / 1_000
      cpuSamplesUs.push(cpuElapsedUs)
      wallSamplesMs.push(wallElapsedMs)
    }
  } finally {
    threadCpuClock.close()
  }

  return {
    cpuP99Us: p99(cpuSamplesUs),
    sampleCount: cpuSamplesUs.length,
    wallP99Ms: p99(wallSamplesMs),
  }
}
