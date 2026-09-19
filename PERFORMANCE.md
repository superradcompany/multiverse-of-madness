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

## Remaining verification

- Correlate individual decisions with preparation, Jev, journal, fork and
  checkpoint timings. The observer's session-level metadata misses most parallel
  decisions, and delivered frame versions do not measure browser paint FPS.
- Measure how much preparation/prefetch work is consumed versus invalidated.
  Evaluate moving provisioning off the decision path while preserving fresh
  invocation isolation, revision provenance and joined cancellation/cleanup.
- Compare changes under matched gameplay, model intervals and concurrent load;
  record simulation rate, browser delivery/paint, winner continuation and cleanup.
- Run sustained gameplay plus background evaluation and verify actual resource
  cleanup. A saved `released` phase alone is not a current process check.

Fresh runtime qualification requires resuming the stopped demo and must wait for
the user's direction. Offline tests cover report cohort boundaries, missing phase
coverage, status/revision separation, duplicate rejection and omission of payloads.
