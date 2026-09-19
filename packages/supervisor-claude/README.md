# Claude Code supervisor provider

Implements the generic `SupervisorProvider` port through the installed Claude CLI
and its existing server-side login. Doom background learning selects unrestricted
mode:
`--print --dangerously-skip-permissions --no-session-persistence --output-format json`.
No host-imposed cost, time, turn or input/output-size caps apply in this mode.
The caller can still cancel; the process watchdog joins cleanup on cancellation
and host shutdown. Requests run in a temporary scratch directory.

The reusable provider retains its bounded, tool-free default for callers that
explicitly supply a bounded experiment contract. Production learning requests
pass `unrestricted: true`; that mode is part of the provider identity.

Usage receipts preserve the actual serving-model names, reported tokens and
reported dollar cost. CLI-reported cost is not an account invoice. Credentials
and the Doom/Jev key are not included in evidence packets or receipts. Historical
bounded runs and overruns remain recorded; they are not retried or erased.

Returned proposals still pass host validation and independent evaluation before
activation. CLI permissions do not grant a returned artifact activation rights.
The implementation is POSIX-only; Windows needs process-group cleanup support.
