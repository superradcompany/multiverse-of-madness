# Codex CLI supervisor provider

Implements `SupervisorProvider` using the installed Codex CLI and its existing
server-side authentication. The learning lab defaults to this provider and can
select Claude for each new improvement request.

Invocation: `codex exec --dangerously-bypass-approvals-and-sandbox
--skip-git-repo-check --ephemeral --color never --json --output-last-message PATH -`.
Prompts arrive on stdin; scratch work uses a temporary directory. No host-imposed
cost, turn, request-count, time or input/output-size cap applies. Cancellation and
host exit still join process-group cleanup. Completed output must be JSON and is
validated by the game adapter before it becomes a reviewable proposal.

Codex JSONL reports token usage. The provider retains it with the raw events and
does not fabricate dollar costs or actual serving-model identity. The default
model follows the CLI configuration unless the host explicitly selects one.
Neither credentials nor the Jev key are sent in the request or written to receipts.
