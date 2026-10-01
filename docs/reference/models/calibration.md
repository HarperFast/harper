---
id: calibration
title: Calibration
---

<!-- Source: harper resources/models/calibration.ts, resources/models/calibrationStore.ts, resources/models/generativeDecision.ts, resources/models/Models.ts (v5.3.1) -->

<VersionBadge version="v5.3.1" />

A decision's `probability` ranks its choices well, but it is not a measured chance of being right. A model can say 0.9 and be right only 70% of the time. Calibration learns that gap from the outcomes you record and answers two questions from Harper itself:

- When a decision says 0.8, is it right about 80% of the time?
- At which threshold can you automate, how much of your traffic does that cover, and how often is it wrong?

## How it works

1. You record decisions with [`persist: true`](./api#recording-decisions) and later report what really happened with [`recordOutcome()`](./api#recordoutcome).
2. A fit run, periodic or started with [`models.calibrate()`](#calibrate), groups the recorded decisions into [populations](#what-a-population-is). For each one it fits a correction on the older decisions and tests it on the newest ones, which it did not train on.
3. When the correction measurably beats the raw probabilities on those newest decisions, later decisions from the same population are corrected and report `calibrated: true`. The chosen `value` never changes, only how confident the decision says it is.
4. Every population with at least 20 recorded outcomes also gets a [reliability report](#choosing-a-threshold), whether or not a correction qualifies.

The correction is temperature scaling: one number per field that stretches or squeezes the distribution. It keeps the order of the values, so the most probable value stays the most probable, and ties stay tied.

## Turning it on

Add a `calibration` block to the `models` configuration. An empty block uses the defaults:

```yaml
models:
  generative:
    default:
      backend: openai
      apiKey: ${OPENAI_API_KEY}
      model: gpt-4o
  decision:
    default:
      backend: generative
      generative: default
  calibration: {}
```

Calibration learns only from decisions recorded while it is enabled, because only those carry the identity of the model that produced their scores. Turn it on before you start recording the outcomes you want it to learn from.

What it costs:

- **Per decision:** nothing you would notice. Harper looks up the population's correction in memory and applies it. It never waits on storage and never makes another model call.
- **Per run:** one run a day by default, on one node of the cluster. It reads recorded decisions and their outcomes, within [budgets](#configuration) on decisions, populations, memory and time.

Removing the block turns calibration off at the next configuration reload: decisions come back uncorrected, and the job stops.

## Recording outcomes calibration can use

- Record with `persist: true`, or give the [`@decide` directive](../database/schema#decide) a `decision` field. Unrecorded decisions have nothing to attach an outcome to.
- Report against a record's decision id only while the record still holds the input that decision saw. A tracked-instance edit after `update()`, a CRDT operation, or a write sent with `x-replicate-from: none` [changes the source without deciding again](../database/schema#decide) and keeps the old id, and a truth reported through it would label a decision made on different input.
- Report the truth with `{ truth: { kind: 'value', value } }`. A `noMatch` truth, meaning none of the allowed values was right, is left out of the fit but counts as an error in the [operational risk](#choosing-a-threshold). An `unknown` truth is ignored. Correcting a truth later is fine: the next run notices and refits.
- **Record the truth for a random sample of decisions, not only the ones people happened to review.** Reviewed cases are usually the hard ones, and a calibration learned only from them describes them, not your traffic. Each report shows how many decisions it read and how many had a truth.

## Choosing a threshold

[`models.getCalibrations()`](#getcalibrations) returns the newest report for each field of each population. The part that answers "where can I automate?" is the selective-risk table, one row per threshold:

```javascript
const recent = await models.getDecision(ticket.decisionId);
const summaries = recent ? await models.getCalibrations({ model: recent.model }) : [];
const route = summaries.find(
	(summary) =>
		summary.field === undefined &&
		summary.signature === recent.signature &&
		summary.instructionsHash === recent.instructionsHash &&
		summary.schemaHash === recent.schemaHash
);
const table = route?.applied ? route.report.calibrated.operational : route?.report?.raw.operational;
```

Each summary describes one field of one population: a model can have several, one per schema, instructions and configuration, and an object schema has one per field. Match the summary to a recent decision of the kind you are thresholding, here the one saved on a routed ticket as in [Start here](./overview#start-here-typed-decisions), so that another schema or set of instructions on the same model is never read by mistake. While calibration is on, the built-in adapter's `signature` names the entry that produced the scores, so after a model or [`revision` change](#when-the-deployment-changes-but-the-configuration-does-not) new decisions carry a new signature and the retired population no longer matches; a [custom decision backend](#what-a-population-is) gets the same only if it changes its `signature` when its scores change. `table` stays undefined when the decision has expired or has not replicated to this node yet, and while its population has fewer than 20 recorded outcomes and so no report: keep your cautious threshold then. Read the `calibrated` table only when `applied` is true: a correction that was fitted but did not qualify still has a `calibrated` table, but no decision uses it. Otherwise read `raw`, which describes the probabilities your decisions actually carry. Each table looks like this:

```json
[
	{ "threshold": 0.8, "count": 412, "coverage": 0.61, "risk": 0.018, "riskUpper": 0.034 },
	{ "threshold": 0.9, "count": 305, "coverage": 0.45, "risk": 0.007, "riskUpper": 0.02 }
]
```

At each threshold:

- `coverage` is the share of decisions whose probability was at or above it: what automating above that threshold would handle.
- `risk` is how often those decisions were wrong.
- `riskUpper` is a 95% upper bound on that error rate, from how many decisions it is based on. With few decisions the bound is wide. **Choose a threshold by `riskUpper`, not `risk`**, so a lucky small sample does not look safer than it is.
- `conditional` counts only decisions whose truth was one of the allowed values. `operational` also counts `noMatch` truths as errors, so it shows what automating would really get wrong when some inputs fit none of the values.

For example, if you can accept 2% errors, pick the lowest threshold whose `operational` `riskUpper` is at most 0.02 and whose `count` is large enough for you to trust. Then automate above it and send the rest to review.

The report also has `ece` (expected calibration error: how far stated probabilities are from observed frequencies, lower is better), `nll` (negative log-likelihood), and ten reliability `bins` of stated confidence against observed accuracy. `raw` describes the uncorrected probabilities and `calibrated` the corrected ones, both on the newest held-out decisions (`window: 'heldOut'`). A correction that was fitted but did not qualify keeps both, with `eligible: false`. When there were too few outcomes to fit at all, only `raw` is present, described over every labelled decision, and `window` is `'all'`.

## What a population is

A correction learned for one model never applies to another. Decisions share a population, and therefore a correction, only when all of these match:

| Part             | What it covers                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Tenant           | The tenant of the calling user. Decisions without a tenant form their own population.                                              |
| Logical model    | The `model` option, `default` when omitted                                                                                         |
| Decision entry   | A fingerprint of that decision entry's settings                                                                                    |
| Score source     | The configured generative entry that actually produced the scores, from a fingerprint of its settings, plus the adapter's settings |
| Instructions     | The `instructions` option                                                                                                          |
| Schema and field | The decision schema, and for an object schema each field separately                                                                |

A fingerprint covers every setting of an entry except its `fallback` list and fields named as credentials: `apiKey`, `apiSecret`, `accessKeyId`, `secretAccessKey`, `sessionToken`, `authorization`, `password`, `token`, `bearerToken`, `credential` and `credentials`, matched without regard to case. A secret stored under any other name is part of the fingerprint, so rotating it starts calibration over. So:

- Renaming an entry, or changing its model, endpoint, sample count or other setting, starts a new population, and the old correction stops applying at once. A new model has a different confidence profile, so learning it again is correct.
- Rotating a credential in one of those fields, reordering fallbacks, or adding an unrelated entry keeps every correction.
- The route or resource that made the call is not part of the population, so the same question asked from two endpoints shares one correction.

Some decisions are never corrected and never learned from:

- A decision whose inner calls were served by entries with different fingerprints, for example a vote in which a sample fell back to another entry, even one of the same provider, or an object schema whose fields were scored by different entries. Its probability mixes two sources' confidence. An entry's name is part of its fingerprint, so a fallback between two entries is never one source, even when their settings are identical.
- A decision made through the built-in adapter over a generative backend a component registered from code, because Harper cannot identify that backend's model.

A [custom decision backend](./backends#decision-backends) identifies its own score source through the `signature` it returns. It must change that signature whenever what produces its scores changes. When that can happen without Harper seeing it, for example new weights behind the same endpoint, fold the entry's `revision` (on the `config` its [factory](./backends#config-selectable-backends) receives) into the signature, so a `revision` bump also gives its decisions a new signature and the threshold lookup above can tell the old population from the new one.

### When the deployment changes but the configuration does not

A fingerprint sees only the configuration. If the same settings start reaching a different model, the old correction would keep applying. That happens with a floating tag such as `llama3:latest` after a pull, a model name that resolves to new weights, or a credential for another account behind the same endpoint. Give the entry a `revision` and change it whenever that happens:

```yaml
models:
  generative:
    default:
      backend: openai
      baseUrl: http://localhost:8000/v1
      apiKey: ${VLLM_API_KEY}
      model: Qwen/Qwen2.5-7B-Instruct-AWQ
      revision: 'weights-2026-09-01'
```

`revision` is a plain, non-secret string available on every entry. Harper only includes it in the fingerprint. A deployment that pins model versions can set it to the version or digest.

## When a correction applies

- **Right after a start, decisions come back uncorrected for a moment.** Each node loads a population's correction in the background after its first decision, and rechecks it about once a minute while it keeps applying the one it has. Corrections replicate like other system tables, so a new fit or a revocation takes effect on a node within about a minute of reaching it; a node behind on replication keeps its previous correction until it catches up.
- **Only an eligible, current correction applies.** It must have beaten the raw probabilities on the held-out decisions, be younger than `maxAgeMs` (30 days by default), and have been fitted under the current settings. A newer run whose evidence no longer supports it, for example after truths were corrected, revokes it everywhere.
- **All fields or none.** An object schema is corrected only when every field has a correction.
- **A schema with a `noMatch: true` leaf is not corrected yet**, because its [no-match score](./api#no-match-scores) would stay uncorrected under `calibrated: true`. It still gets reliability reports, with the reason `no-match-schema`.
- **`requires: ['calibrated']` is unchanged.** It still routes only to a backend that calibrates its own probabilities. To automate only corrected decisions, check `decision.calibrated` and send the rest to review, which keeps a decision you have already paid for.

## Configuration

Every setting of `models.calibration` is optional.

| Setting             | Default                | Meaning                                                                                                                                           |
| ------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interval`          | `86400000` (1 day)     | Milliseconds between runs; at least one hour                                                                                                      |
| `minReport`         | `20`                   | Recorded outcomes a field needs before it gets a report                                                                                           |
| `minTrain`          | `100`                  | Outcomes on the older, training side a correction needs                                                                                           |
| `minHeldOut`        | `100`                  | Outcomes on the newest, held-out side a correction needs                                                                                          |
| `heldOutShare`      | `0.3`                  | Share of each population's newest outcomes held out for testing                                                                                   |
| `eceMargin`         | `0.01`                 | How much a correction must lower the held-out calibration error to qualify                                                                        |
| `maxAgeMs`          | `2592000000` (30 days) | How long a correction applies before a newer run must replace it                                                                                  |
| `maxDecisions`      | `100000`               | Recorded decisions a run reads in total: at most half to find new populations, the rest to fit. Must be at least twice `maxExamplesPerKey` plus 2 |
| `maxPopulations`    | `1000`                 | Populations a run handles                                                                                                                         |
| `maxExamplesPerKey` | `5000`                 | Newest recorded decisions a run reads per population                                                                                              |
| `maxBytes`          | `67108864` (64 MB)     | Estimated memory a run may hold                                                                                                                   |
| `maxRunMs`          | `60000`                | Time a run may take                                                                                                                               |
| `maxLoads`          | `8`                    | Correction lookups a node runs at once in the background                                                                                          |

A run that reaches a budget stops cleanly and says which one. Populations it did not reach go first next time, because each run starts with the populations that were fitted least recently. Up to half of `maxDecisions` looks for new populations, split between the newest decisions and a continuation of where the previous run stopped, so an older, quiet population is always reached eventually, after as many runs as it takes to page past the decisions ahead of it; the rest of the budget reads decisions for fitting. A population found but not fitted is remembered, and a later run fits it. A population a run cannot finish, because it is too large for what the run has left or runs into the byte or time budget, goes to the back of the queue rather than holding up the others. A run that fails, for example because recorded outcomes could not be read, fails its scheduled job, so the scheduler's job status shows it.

## API

### calibrate()

```typescript
models.calibrate(budgets?: CalibrationBudgets): Promise<CalibrationRunResult>
```

Runs a fit now, as the periodic job does. Useful in development and tests, or right after recording a batch of outcomes. `budgets` may lower, never raise, this run's `maxDecisions`, `maxPopulations`, `maxExamplesPerKey`, `maxBytes` and `maxRunMs`; the settings that decide whether a correction qualifies always come from configuration, so every node judges a version by the same rules. It resolves with what the run did and never rejects for a storage fault: the fault is reported in the result.

A run covers every tenant's decisions, and its result counts all of them. Treat it as a maintenance operation: call it from trusted code, and do not return its result to a tenant.

| Field                                  | Meaning                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `status`, `error`                      | `completed`, or `failed` with a short error, for example when recorded decisions could not be read                 |
| `scanned`, `read`, `discovered`        | Recorded decisions scanned to find populations, decisions read for fitting, and populations found or already known |
| `processed`, `pending`                 | Populations fitted this run, and those left for the next                                                           |
| `written`, `eligible`                  | New versions written, and how many of them qualify to apply                                                        |
| `skipped`, `failed`                    | Fields with nothing new since the last run, and populations that could not be read                                 |
| `stoppedBy`, `reachedAt`, `durationMs` | The budget that stopped the run, if any; the oldest decision time it reached; how long it took                     |

### getCalibrations()

```typescript
models.getCalibrations(filter?: { model?: string }): Promise<CalibrationSummary[]>
```

The newest version for each field of each population whose tenant is the caller's, newest first. The tenant comes from the calling user and cannot be passed in; decisions made without a tenant are visible only to callers without one.

| Field                                         | Meaning                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`, `field`                              | The logical model, and the field for an object schema                                                                                                                                                                                                                                          |
| `signature`, `instructionsHash`, `schemaHash` | What identifies the population                                                                                                                                                                                                                                                                 |
| `eligible`, `reason`                          | Whether the correction qualified, and if not, `too-few-labels`, `no-improvement` or `no-match-schema`                                                                                                                                                                                          |
| `applied`                                     | Whether the version qualifies to apply: eligible, current, and fitted under the current settings. A node applies it once its cache has loaded it, and a population that no longer receives decisions, for example after a `revision` change, keeps reporting its last version until it expires |
| `fittedAt`, `applyUntil`                      | When it was fitted, and when it stops applying                                                                                                                                                                                                                                                 |
| `decisions`, `labelled`                       | Recorded decisions the run read for this population, and how many had a truth                                                                                                                                                                                                                  |
| `t`                                           | The temperature: above 1 softens overconfident probabilities, below 1 sharpens underconfident ones                                                                                                                                                                                             |
| `report`                                      | The [reliability report](#choosing-a-threshold), from 20 outcomes                                                                                                                                                                                                                              |

## Storage

Corrections are immutable versions in the `hdb_model_calibrations` system table, which replicates. A version records the settings it was fitted under and its report. A recorded decision that was corrected keeps its uncorrected scores (`rawDistribution` or `rawFields`) and the version it applied (`calibration`) on its [`hdb_model_decisions`](./analytics#durable-decisions) row, so a later run never learns from its own output, and every corrected decision can be traced to the report behind it. Versions expire after the decisions that used them.
