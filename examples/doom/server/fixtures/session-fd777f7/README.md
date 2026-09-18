# Pre-extraction session fixture

Produced by session.ts and recordings.ts from commit fd777f7, using a deterministic
fake runtime and decision provider. The producer is extracted unchanged with git
archive by scripts/qualification/generate-legacy-session.ts. These are persisted
format fixtures, not real gameplay recordings or VM snapshots.

The fixture contains an execution-checkpoint record, an unchanged source, two
completed alternate futures, experience and compressed recording segments.

The verbatim historical `examples/doom/server/src/persistence.ts` reader is also retained as
`persistence.ts.source` (SHA-256
`9f4d165d58ad9e1187ff6ae759d79782ee8f0767bfbd549b63bd4c5e9ce32567`).
The learning-revision compatibility test compiles this trusted fixture with the
existing TypeScript build tool, verifies it loads the original version-1 session,
and confirms it refuses a newly produced supervised version-2 session.
