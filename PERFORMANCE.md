# Performance investigation

The current evidence identifies decision-boundary overhead. It does not establish
that the reported frame-rate problem is fixed. Demo servers and local VMs remain
stopped at the user's request; this analysis reads saved artifacts only.

## Reproduce an offline executor report

From the repository root after installing dependencies:

```sh
node --import tsx scripts/analyze-executor-performance.ts \
  --from 2026-09-18T20:42:14.904Z --to 2026-09-18T20:44:14.932Z \
  /path/to/learning/executor-runs.json \
  /path/to/learning/evaluation-executor-runs.json > /tmp/executor-performance.json
```

Omit both timestamps for a full-journal report. Each supplied journal gets its own
report; snapshots and decision receipts may overlap and must not be summed.
The window selects receipt start timestamps in `[from, to)`. Records without
receipts cannot be assigned to a window. Missing phase measurements remain unknown,
and successful, failed, cancelled and timed-out work is reported separately.
Reports include revision/provider identities but omit source, input, output and
error text. This command never imports the VM executor or calls a model.

## Matched historical sample

Analysis date: 2026-09-19. Measurement window: 2026-09-18, 20:42:14.904–20:44:14.932
UTC, approximately 120 seconds. Sources are retained locally under
`/Users/toks/Documents/Coding/workspaces/multiverse-learning-next/`:

- Delivery observer: `artifacts/live-performance/2026-09-18/active-supervisor/delivery.json`.
- Matching executor journals: `.data-demo-20260918/learning/lineages/d3b9bd3b-4684-4129-b586-09cdff89a158/`.
- Generated reports and input SHA-256 hashes: `artifacts/performance-analysis/2026-09-19/`
  in the analysis checkout. These artifacts are local and ignored by Git.

The top-level executor journal belongs to an earlier window (10:17–11:05 UTC).
Its 1,049 executions must not be used to attribute the later delivery sample.
The matching archived lineage contains 190 invocations starting in the measured
window: 184 completed and six cancelled, all with phase timings and recorded as
released. There were no evaluation-executor starts in this window. That does not
exclude overlapping prior work, supervisor CLI activity or other host load.

| Successful executor work (184 receipts) | Median | p95 |
| --- | ---: | ---: |
| Receipt elapsed time | 390 ms | 447 ms |
| Provisioning, identity journal and isolation checks | 183.5 ms | 215.5 ms |
| Upload | 3.2 ms | 8.7 ms |
| Execution | 142.0 ms | 177.9 ms |
| Joined cancellation and VM destruction | 57.1 ms | 66.4 ms |

Cancelled invocations took a median of 306 ms, with a maximum of 398 ms. All 190
used one strategy revision and one executor provider version. Receipt elapsed time
excludes initial and final journal writes; it is not total decision latency.
Phase percentiles are independent and cannot be added to reconstruct the elapsed
percentile. Parallel invocation durations are not wall-clock utilization.

The same observer recorded 6,953 ordinary exploration frame-version gaps with a
median of 30.7 ms and p95 of 60.1 ms. Its 253 gaps marked as including a decision
wait had a median of 605.0 ms and p95 of 807.5 ms. Eight session-level decision
samples had median request duration 609.5 ms and median blocking wait 598.8 ms;
three were prefetched. These are different cohorts, so subtracting executor
medians from decision medians would not isolate Jev inference time.

Inference: isolated strategy execution is substantial decision-path work, while
ordinary frame delivery is much faster. Provisioning and cleanup are plausible
optimization targets. This is evidence for investigation, not a causal breakdown
of each visible pause or a benchmark of the current source revision.

## Early cancellation of stale prefetches

The Doom session now checks an owned prefetch while its current plan advances.
When observed facts or instructions invalidate it, cancellation starts immediately
instead of waiting for the next decision boundary. Its cleanup can overlap the
rest of the plan. The slot stays owned until decision consumption or pause joins
cleanup, and remains occupied so repeated combat changes cannot dispatch a new
speculative call every frame. Boundary checks still reject stale answers.

A controlled session test changes health 20 ticks into a plan, observes cancellation
at that tick, advances five more ticks while cleanup is still pending, and releases
cleanup at 30 ticks before a fresh decision at the 35-tick boundary. A core test verifies that
even a provider returning an answer after cancellation cannot revive the result;
ownership cannot be reused before cleanup joins. Existing tests cover usable
prefetches, changed instructions/skills and expired temporary goals.

This removes a late-cancellation path; it does not remove the need to request a
fresh decision after changed facts. A local predicate microbenchmark against five
saved world states averaged about 0.0042 ms per check over 50,000 checks. That is
only repeated-state CPU cost, not live performance or proof of pause reduction.
The change is not deployed to the stopped demo and has no new VM qualification.

## Decision timing coverage

The host now attaches the latest consumed decision's timing to each world, so
parallel futures are observable independently of the main-session summary.
Prepared decisions report context/source loading, isolated preparation (including
validation and journal waits), and judgment (including Jev and usage journaling).
Their executor run ID links directly to the corresponding executor journal record.
Executor elapsed time is nested inside preparation; do not add it again.

Request duration and boundary wait remain separate: prefetch can finish most work
before consumption, while rejecting stale work can make a boundary wait exceed the
fresh request duration. Source and consumption ticks make that distinction visible.
Only the latest metadata is retained on each world. It contains no request payload,
model response, source code or credentials, and never changes gameplay scores.
Older sessions without this optional field still load.

Observer format 3 (`scripts/observe-live-performance.ts`) adds individual world
samples and stage distributions while preserving the existing main-decision
summary. It excludes initial metadata and decisions consumed before observation,
including historical decisions reintroduced by rollback. This assumes synchronized
server/observer wall clocks. It can still miss overwritten or failed/cancelled
decisions; it is not a complete request journal. The observer now captures its
start wall time directly rather than reconstructing it after shutdown/polling.
Do not run it until the demo is intentionally resumed.

An offline journal check used a copied historical 4 MB, 4,386-record journal in a
temporary directory, leaving the source unchanged. Across 32 saves in eight
four-write bursts, median serialization was 1.34 ms, completion was 6.69 ms, and
burst completion was 10.24 ms. This isolated host measurement does not explain
the approximately 600 ms decision waits and does not justify changing persistence
formats. Details: `artifacts/performance-analysis/2026-09-19/journal-cost.json`.

## Supervisor evidence size

Run a read-only report over a learning directory and its historical lineages:

```sh
node --import tsx scripts/analyze-supervisor-history.ts /path/to/learning
```

The report emits counts and an archive fingerprint, not prompts or game data.
Duplicate receipt IDs are refused to avoid summing copied history. Missing token
counts remain unknown, historical token-only receipts are supported, and cached
input is not added again. Pending receipts do not enter elapsed-time statistics.

On 2026-09-19, the stopped demo's `.data-demo-20260918/learning` archive contained
63 distinct supervisor receipts across the original directory and 16 lineages:
56 complete and seven cancelled. Median reported input size was 81,353 bytes;
median elapsed time across all settled calls was 138,987 ms. Fifty-six calls
reported 2,755,605 input and 239,146 output tokens in total. Usage for the other
seven calls is unknown. These historical calls span different source revisions
and review circumstances; they are not a current performance benchmark or a
measurement of automatic review cadence.

Among 46 archived preparation examples, 46 of 91 sampled history entries exactly
repeated the current state. The supervisor's illustrative example now omits exact
duplicates of the current state or an earlier sampled entry, reports their counts,
and recalculates valid example history indices. Jev's actual history and the full
supervisor observation evidence are unchanged. Changed ticks, resources, positions
or telemetry are retained even when the player remains in the same room. Tests
also verify unchanged derived feedback, default plans, current state and stats.

Re-encoding those 46 historical prompt envelopes with this sampling rule and its
explanatory metadata reduced JSON from 4,294,592 to 3,919,228 bytes: 375,364 bytes
(8.74%), with a median reduction of 8,480.5 bytes per envelope. This reuses the
archived example windows; original unsampled history lengths are unavailable.
The local report is `artifacts/performance-analysis/2026-09-19/supervisor-history.json`.
Bytes are not tokens. No new model calls were made, so token/latency savings and
supervisor quality still require matched live measurements. Healthy or unchanged
review suppression is not established by these receipts alone.

## Saved-view delivery CPU check

Reproduce without starting any service:

```sh
node --import tsx scripts/analyze-session-delivery.ts /path/to/session.json
```

The script clones a retained view and advances one live world's tick/frame version
per update. It runs 100 warmups and 500 measured batches for each client count,
using the actual `SessionStream` patch encoder. It verifies reconstruction of the
encoded messages and unchanged source-file contents. The report contains source
and benchmark hashes, revision, environment and measurements, not gameplay
payloads or credentials. `--samples` accepts 10–10000 measured batches.

On 2026-09-19, the stopped `.data-demo-20260918/session.json` provided a 257,840-byte
view with 24 worlds, five with live roles. Runtime code was at `4aab200`, under
Node 26.3.1 on macOS arm64. Source SHA-256:
`9d363a257f71b4830023a80565078d5827d27311c96ece3cc86cf66d7bf4eb35`.
Local report: `artifacts/performance-analysis/2026-09-19/session-delivery.json`.

| View clone + patch calculation + encoding | Median | p95 | Maximum |
| --- | ---: | ---: | ---: |
| One client | 0.98 ms | 1.09 ms | 1.24 ms |
| Four clients | 1.51 ms | 1.67 ms | 2.75 ms |

Each batch shares one clone and sums patch/encoding work for all clients. Median
wire payload was 10,900 bytes per client. This excludes snapshot assembly, PNG
requests/decoding, browser painting, network, persistence, concurrent VM load and
model/executor waits. Repeated saved-state timings do not establish live FPS or
rule out CPU contention in a running session. This sample provides no evidence
that metadata serialization accounts for the previously observed ~600 ms decision
waits; it does not justify replacing the stream protocol to address those waits.

## Remaining verification

- Collect the new per-world timing samples and match their executor IDs to phase
  measurements. Fork/checkpoint timings and individual journal waits still need
  correlation; delivered frame versions do not measure browser paint FPS.
- Measure how much preparation/prefetch work is consumed versus invalidated.
  Evaluate moving provisioning off the decision path while preserving fresh
  invocation isolation, revision provenance and joined cancellation/cleanup.
- Compare changes under matched gameplay, model intervals and concurrent load;
  record simulation rate, browser delivery/paint, winner continuation and cleanup.
- Run sustained gameplay plus background evaluation and verify actual resource
  cleanup. A saved `released` phase alone is not a current process check.

Fresh runtime qualification needs isolated VM/model runs or resuming the stopped
demo, and still awaits the user's direction. Offline tests cover report cohort
boundaries, missing phase coverage, status/revision separation, duplicate rejection and omission of payloads.
