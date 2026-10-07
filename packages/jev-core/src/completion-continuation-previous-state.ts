export type CompletionContinuationPreviousAvailable = {
  readonly available: true
  readonly todoStatusDigest: string
  readonly boulderDigest: string | null
  readonly todo: {
    readonly total: number
    readonly completed: number
  }
  readonly boulder: {
    readonly total: number
    readonly completed: number
    readonly remaining: number
  } | null
  readonly continuationDispatched: boolean
}

export type CompletionContinuationPreviousUnavailable = {
  readonly available: false
  readonly reason: "first_idle"
}

export type CompletionContinuationPreviousState =
  | CompletionContinuationPreviousAvailable
  | CompletionContinuationPreviousUnavailable
