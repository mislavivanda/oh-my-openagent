# Todo 4 question text and scope

## What was tested

- Inspected `packages/jev-core/src/completion-continuation-questions.ts` after the edit.
- Ran the focused question test to verify the exact three keys, question version 2, previous-block field guidance, first-idle behavior, independent probabilities, and unchanged `actually_complete` text.
- Reviewed the source diff to confirm the implementation remains plain data with no I/O or harness import.

## What was observed

- `COMPLETION_CONTINUATION_QUESTION_VERSION` is `2`.
- The keys remain exactly `actually_complete`, `progressing`, and `stuck`.
- `actually_complete` is byte-identical to the pre-change block. The restricted empty-diff proof is in `task-4-actually-complete-byte-identity.txt`.
- `packages/jev-core/src/index.ts` already exported the version, key list, questions, and related types by name, so no barrel edit was required.

### progressing

Instructions:

> Estimate whether the tracked work progressed since the previous idle. When previous.available is true, compare current todo.statusDigest, todo.total, todo.completed, inputDigests.boulder, boulder.total, boulder.completed, and boulder.remaining with previous.todoStatusDigest, previous.todo.total, previous.todo.completed, previous.boulderDigest, previous.boulder.total, previous.boulder.completed, and previous.boulder.remaining. If previous.available === false, no predecessor exists; this is not a predecessor with null values. No delta can be observed on this first idle, so give low confidence near the middle rather than guessing true or false. Give an independent probability, not a forced single class. A record may legitimately be high on more than one question or low on all three.

True criterion:

> With previous.available true, todo.completed or boulder.completed increased, todo or boulder remaining work decreased, todo.statusDigest or inputDigests.boulder changed in a way that reflects tracked progress, or tracked work became complete relative to previous.todo and previous.boulder.

False criterion:

> With previous.available true and previous.continuationDispatched true, tracked work remains incomplete and current todo.statusDigest, todo.total, todo.completed, inputDigests.boulder, boulder.total, boulder.completed, and boulder.remaining stayed unchanged from previous.todoStatusDigest, previous.todo, previous.boulderDigest, and previous.boulder.

### stuck

Instructions:

> Estimate whether the tracked work became stuck since the previous idle. When previous.available is true, compare current todo.statusDigest, todo.total, todo.completed, inputDigests.boulder, boulder.total, boulder.completed, and boulder.remaining with previous.todoStatusDigest, previous.todo.total, previous.todo.completed, previous.boulderDigest, previous.boulder.total, previous.boulder.completed, and previous.boulder.remaining. Use previous.continuationDispatched to decide whether a successful continuation occurred between snapshots; do not infer that precondition from current values. If previous.available === false, no predecessor exists; this is not a predecessor with null values. No delta can be observed on this first idle, so give low confidence near the middle rather than guessing true or false. Give an independent probability, not a forced single class. A record may legitimately be high on more than one question or low on all three.

True criterion:

> With previous.available true and previous.continuationDispatched true, tracked work remains incomplete while current todo.statusDigest, todo.total, todo.completed, inputDigests.boulder, boulder.total, boulder.completed, and boulder.remaining stayed unchanged from previous.todoStatusDigest, previous.todo, previous.boulderDigest, and previous.boulder.

False criterion:

> With previous.available true, current values show tracked progress or completion relative to previous.todoStatusDigest, previous.todo, previous.boulderDigest, and previous.boulder.

## Why this is enough

The delta questions now name both sides of the comparison and the successful-continuation precondition. The first-idle wording says that absence means there is no predecessor, not a predecessor containing null values, and requests low confidence near the middle. That gives the model an honest no-delta response without pushing it toward either boolean direction.

## What was omitted

No provider call, token, credential, environment dump, or private configuration was captured. The mock-path test reported `realApiRequested=false` and `networkCalls=0`.
