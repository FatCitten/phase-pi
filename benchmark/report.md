# phase allocation benchmark — research report

_Generated 2026-09-20T19:13:58.334Z · repo commit a196d80 · corpus 9 tasks · 3 configs_

## Method

The shipped CLI (`bin/phase-alloc.mjs`) was invoked end-to-end against the phase repo for each (task, config) pair. Each run produced a full `phase-alloc-servant-v1` plan. Plans were validated for structure, budget ceiling-compliance, tool whitelist, agent presence, and internal ISA↔allocation consistency. Measurements are wall-clock, in-process (`hrtime`).

Budget ceilings enforced by the allocator: context_tokens ≤ 12000, tokens ≤ 24000, wall_ms ≤ 900000, tool_calls ≤ 40, money/human_attention ≥ 0.

## Configurations

| config | policy | SLM endpoint | expected |
|---|---|---|---|
| model-live | model | http://127.0.0.1:11434/v1 | live model |
| heuristic | heuristic | http://127.0.0.1:8080/v1 | deterministic heuristic |
| fallback-down | model | http://127.0.0.1:8080/v1 | model unreachable → heuristic fallback |

## Corpus

| task | domain | complexity | scale |
|---|---|---|---|
| bugfix-auth | bugfix | 2 | small |
| feature-rate-limit | feature | 3 | medium |
| refactor-schema | refactor | 2 | medium |
| docs-quickstart | docs | 1 | small |
| write-unit-tests | testing | 2 | small |
| ci-pipeline | infra | 3 | medium |
| perf-migrate | performance | 4 | large |
| ambiguous-design | design | 4 | large |
| security-patch | security | 3 | medium |

## Results by configuration (scheduled runs)

| config | runs | policy observed | valid | parse fail | mean latency ms |
|---|---|---|---|---|---|
| model-live | 9 | model | 9/9 | 0/9 | **9** &nbsp; (min 5583.039435 / max 15282.402839 / mean 8576.25) |
| heuristic | 11 | heuristic | 11/11 | 0/11 | **11** &nbsp; (min 77.88142 / max 127.702224 / mean 105.63) |
| fallback-down | 9 | heuristic-fallback | 9/9 | 0/9 | **9** &nbsp; (min 1380.089836 / max 1402.16194 / mean 1388.38) |

## Allocation policy observed

| policy | count |
|---|---|
| heuristic | 11 |
| model | 9 |
| heuristic-fallback | 9 |

## Budget behavior

| config | context_tokens (range) | wall_ms (range) | tool_calls (range) | tokens (range) |
|---|---|---|---|---|
| model-live | 6600–6600 | 900000–900000 | 40–40 | 24000–24000 |
| heuristic | 6600–6600 | 900000–900000 | 40–40 | 24000–24000 |
| fallback-down | 6600–6600 | 900000–900000 | 40–40 | 24000–24000 |

> Note: the phase allocator's deterministic heuristic always allocates the smallest viable budget — context = ceil(12000 × 0.55) = 6600, regardless of task. Only the live-SLM path can vary, and only within the caller's ceiling. The near-constant budget across tasks is expected and by-design (no evidence of context misses/failures yet to grow it).


## SLM variability (model-live repeats)

- `bugfix-auth::model-live::rep1` → policy=model, agent=auto, context=6600, wall_ms=900000, tools=edit+test+bash, elapsed=7200ms
- `docs-quickstart::model-live::rep1` → policy=model, agent=auto, context=6600, wall_ms=900000, tools=read+edit+bash+test+edit+bash, elapsed=7823ms
- `perf-migrate::model-live::rep1` → policy=model, agent=auto, context=6600, wall_ms=900000, tools=read+edit+test+bash, elapsed=3536ms

## SLM redundancy (duplicate GRANT lines in model-live ISA)

4/12 model-live runs emitted a duplicated GRANT line (set-semantics: harmless to allocation, but noisy).

- `feature-rate-limit::model-live`: GRANT read GRANT edit GRANT bash GRANT test GRANT edit GRANT bash
- `docs-quickstart::model-live`: GRANT read GRANT edit GRANT bash GRANT test GRANT edit GRANT bash
- `docs-quickstart::model-live::rep1`: GRANT read GRANT edit GRANT bash GRANT test GRANT edit GRANT bash
- `ci-pipeline::model-live`: GRANT read GRANT edit GRANT bash GRANT test GRANT edit GRANT test GRANT edit GRANT test GRANT edit GRANT test GRANT edit GRANT test

## Determinism

- heuristic `bugfix-auth` re-run: IDENTICAL allocation + ISA
- heuristic `security-patch` re-run: IDENTICAL allocation + ISA

## Validation failures

None — every plan passed all structural, ceiling, whitelist, and ISA-consistency checks.

## Files

- corpus: `corpus.json`
- dataset: `data/dataset.jsonl`
- summary: `data/summary.csv`
- raw plans: `data/raw/*.json`
- this report: `report.md`
