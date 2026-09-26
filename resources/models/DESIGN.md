# resources/models/ — model facade, backends, decisions

Notes on invariants the models layer relies on that the code cannot state itself. User-facing behavior is documented in HarperFast/documentation.

## Decision outputs are validated at the facade

A `Decision` returned by `models.decide` names a value from the schema's allowed set, and its distribution has exactly one entry per allowed value, with finite probabilities in [0, 1] that sum to one (within 1e-3), sorted descending with ties in schema order unless the backend chose one of the tied values, which then leads. `normalizeDecision` (`decision.ts`) enforces this on every backend output, so no backend's arithmetic is trusted; a violation is a `DecisionContractError`, which `Models.decide` treats like any backend error (recorded against that backend, next candidate tried). A malformed schema or state rejects before routing and writes no analytics row, because nothing was called. Object schemas are marginal-only: `value` is assembled from each field's argmax and may be a combination no single sample produced. Enforced by `unitTests/resources/models/decision.test.js` and `decide.test.js`.

## The generative adapter reports no usage of its own

Every sample the adapter (`generativeDecision.ts`) takes is a `models.generate` call with its own `hdb_model_calls` row and token metrics. The adapter therefore returns no `usage` on its `ModelCallResult`; reporting the sum again would count each sample twice in `SUM(prompt_tokens)` and in `model-*-tokens`, the same double-billing the `toolMode: 'auto'` outer call avoids by writing no row. Samples run under one `AbortController`: the first failure aborts the rest, and the worker pool is awaited to settlement before the error is thrown, so no sample rejects unobserved and the facade never falls back to another candidate while calls are still in flight. Enforced by `unitTests/resources/models/generativeDecision.test.js`.

## Built-ins serve one kind

The provider factories (`ollama`, `openai`, `anthropic`, `bedrock`) treat every non-embedding kind as generative, so a `models.decision` entry naming one would register a backend with no `decide`. `builtinServesKind` (`bootstrap.ts`) refuses that entry at boot and reload, and `wrongKindEntrySchema` (`validation/configValidator.ts`) refuses it at validation, in both directions: `backend: generative` is the only built-in for `decision` and is refused under `embedding` and `generative`. Module backends are exempt because their factory receives `kind`.
