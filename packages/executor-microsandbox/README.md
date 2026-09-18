# Microsandbox executable provider

`src/executor.ts` implements the harness `ExecutableProvider`. It has no Doom,
chess, UI, model or evaluator dependency. The host supplies a pinned Node 24 image
and an awaited durable `record` callback. Each invocation gets a fresh detached
VM, disabled networking, no mounts/patches, fixed CPUs/memory, and an unprivileged
Node process with a cleared environment. Resolved configuration is checked before
uploading candidate code or observations.

Sources are verified and written as data. No candidate build scripts, imports or
install hooks run on the host. Node strips TypeScript inside the guest. The
entrypoint exports `default(input)`, returning JSON. Relative source imports work;
external packages must be part of an explicitly supplied artifact or image.

Output is streamed under one stdout+stderr byte limit. The host consumes the exit
event from that stream, validates JSON, and always destroys the whole VM, including
any background processes. Cancellation/deadlines join cleanup rather than merely
abandoning a response. Cleanup errors retain the exact runtime record.

Call `recover` on unfinished records only after obtaining exclusive ownership of
the invocation journal and establishing that its former host has stopped. Recovery
checks ownership labels and any acknowledged physical identity before deleting;
a mismatched identity is refused. A creating record may have no acknowledged
physical identity yet, so ownership labels identify that invocation. Recovery
never repeats candidate computation.

Terminal invocation records may include diagnostic `timings`: VM creation (plus
identity journaling and isolation checks), source upload, guest execution and
cleanup. These host wall times include failed phases and are not evaluation
scores. Older records without timings remain valid. The final receipt journal
flush is outside the receipt's elapsed time.

`node --import tsx scripts/executor-load-smoke.ts` runs the production provider
with one and four concurrent invocations in interleaved batches. It checks clean
per-call state, network isolation, unprivileged execution and removal of every
test VM. It reports phase timing under a mechanical workload, not gameplay or
model performance.

An artifact is not trusted merely because it has a hash. Keep evaluator code,
credentials, canonical histories and game states outside its VM. Validate returned
actions against the current game's legal commands and measure actual outcomes on
the host. Record the source/provider/image identities and limits with each run.

Run `npm run smoke:executor` from the application root. It verifies real VM
isolation, relative TypeScript imports, output limits, timeout, cancellation,
cleanup and recovery after the creating host exits. `npm run qualify:executor`
checks independent evaluation, rejection, executable activation, restart,
continued use of the selected code, and rollback using fixed chess cases.
