---
id: overview
title: Models
---

<!-- Source: harper resources/models/Models.ts, resources/models/types.ts, resources/models/bootstrap.ts (v5.1) -->

<VersionBadge version="v5.1.0" />

Harper provides a unified API for calling AI models — text embeddings, text generation, and typed decisions — from application code. Models are configured by an operator under logical names; application code requests a model by its logical name and Harper routes the call to the configured backend (Ollama, OpenAI, Anthropic, or Amazon Bedrock) — or to a [custom backend](./backends#custom-backends) a component registers. Swapping providers is a configuration change, not a code change — [Local Development](./local-development) uses this to run the same application against local models in development and hosted providers in production. A logical name can also name an ordered group of backends to try, and calls can require specific capabilities — see [Routing & Fallback](./routing).

The API is exposed as a single process-wide `models` object:

```javascript
import { models } from 'harper';

const [vector] = await models.embed('What is Harper?');
const reply = await models.generate('Describe the Harper resource API in one sentence.');
const route = await models.decide(ticket.body, { enum: ['billing', 'refund', 'bug', 'other'] });
```

The same object is available as `scope.models` in component scopes and as the `models` global. All three refer to the same instance.

The API surface is eight methods:

| Method                                                             | Purpose                                                                                            |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| [`models.embed(input, options?)`](./api#embed)                     | Convert text to embedding vectors                                                                  |
| [`models.generate(input, options?)`](./api#generate)               | Generate a completion for a prompt or chat                                                         |
| [`models.generateStream(input, options?)`](./api#generatestream)   | Stream a completion as it is produced                                                              |
| [`models.decide(state, schema, options?)`](./api#decide)           | Choose from a closed set, with a probability distribution over it                                  |
| [`models.getDecision(id)`](./api#getdecision)                      | Read a decision recorded with `persist: true`, and what was recorded about it since                |
| [`models.recordOutcome(id, outcome)`](./api#recordoutcome)         | Record what actually happened for a decision recorded with `persist: true`                         |
| [`models.calibrate(budgets?)`](./calibration#calibrate)            | From v5.3.1, fit calibrations from recorded outcomes now                                           |
| [`models.getCalibrations(filter?)`](./calibration#getcalibrations) | From v5.3.1, read how reliable each population's decisions are, and the correction applied to them |

Generation supports [tool calling](./tool-calling), including a built-in agent loop (`toolMode: 'auto'`) that resolves tool calls in-process. Decisions are served by [decision backends](./backends#decision-backends), including a built-in adapter that scores the allowed values from any configured generative model's log-probabilities where the model exposes them, and votes over structured completions otherwise. Tables can compute embedding vectors automatically at write time with the [`@embed` schema directive](../database/schema#embed), and vectors can be searched with [HNSW vector indexes](../database/schema#vector-indexing); the [`@decide` schema directive](../database/schema#decide) likewise stores a typed decision and its probability whenever a source field is written. New to decisions? Begin with [Start here: typed decisions](#start-here-typed-decisions). Every model call is recorded for [observability and usage accounting](./analytics).

## Start here: typed decisions

<VersionBadge version="v5.3.0" />

`decide()` answers a question with one value from a list you give it, plus how likely each value is. Use it for routing, moderation, triage, and yes/no checks. Most applications need only the four steps below. The [API reference](./api#decide) covers everything else.

**1. Configure one decision model.** A decision model sits on top of a generative model. This is the smallest working configuration:

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
```

With OpenAI, a decision whose fields each have at most 20 allowed values costs one scoring call per field. If any field has more, or the model cannot score, the whole decision is asked `samples` times (default 5) and the answers are counted, which multiplies the token cost. [Generative decision adapter](./backends#generative-decision-adapter) has the details.

**2. Make a decision.** Call `decide()` from code. Here `ticket` is a record your application has loaded, and `route` and `sendToReview` in the next steps stand for your own handling:

```javascript
import { models } from 'harper';

const queues = {
	enum: ['billing', 'refund', 'bug', 'other'],
	description: 'Which queue should handle this support ticket?',
};
const decision = await models.decide(ticket.body, queues);
```

`decision.value` is the chosen queue, and `decision.probability` is how likely it is.

Or have a table decide whenever a record is written, with the [`@decide` directive](../database/schema#decide):

```graphql
type Ticket @table {
	id: Long @primaryKey
	body: String
	route: String @decide(source: "body", values: ["billing", "refund", "bug", "other"], confidence: "routeConfidence")
	routeConfidence: Float @indexed
}
```

The directive calls the model on every write that carries a non-null `body`, so it costs one decision per such write.

**3. Act on the probability, and send the rest to a person.** Pick a threshold, automate above it, and route everything below it to review:

```javascript
if (decision.probability >= 0.8) await route(ticket, decision.value);
else await sendToReview(ticket, decision);
```

With the directive, apply the same rule to the stored `route` and `routeConfidence`.

`decision.calibrated` is `false` for the built-in adapter. Its probability ranks the choices well, but it is not a measured frequency: 0.8 does not mean the decision is right 80% of the time. Start with a cautious threshold and adjust it once you know how often decisions above it turn out right, which is what step 4 is for. From v5.3.1, with [calibration](./calibration) turned on, Harper measures that for you from the outcomes you record, corrects later probabilities, and reports which threshold covers how much traffic at what error rate.

**4. Record outcomes only when you will use them.** By default nothing is stored beyond the per-call log, and the result has no `id`. When you want to check decisions against what really happened, add `persist: true` to the step 2 call and keep the decision's `id` with what you did:

```javascript
const decision = await models.decide(ticket.body, queues, { persist: true });
if (decision.probability >= 0.8) await route(ticket, decision.value, decision.id);
else await sendToReview(ticket, decision);
```

If `route` saved the id on the ticket as `decisionId`, report the queue a person later confirms against it:

```javascript
await models.recordOutcome(ticket.decisionId, { truth: { kind: 'value', value: ticket.confirmedQueue } });
```

For a table, add a `decision` field to the directive; it receives the id. [Recording decisions](./api#recording-decisions) compares the two modes, and [Analytics](./analytics#durable-decisions) shows how to query what was recorded. Record the truth for a random sample of decisions as well as the ones people happened to review, so the record reflects all of your traffic.

## Configuration

<VersionBadge type="changed" version="v5.3.0" />

Models are configured in the `models` section of `harper-config.yaml`, split by capability into `embedding`, `generative`, and `decision` maps. Each key is a logical model name; each entry names a `backend` plus backend-specific settings:

```yaml
models:
  embedding:
    default:
      backend: ollama
      host: localhost:11434
      model: nomic-embed-text:latest
  generative:
    default:
      backend: openai
      apiKey: ${OPENAI_API_KEY}
      model: gpt-4o
    fast:
      backend: ollama
      model: mistral:7b
  decision:
    default:
      backend: generative
      generative: default
      samples: 5
```

The logical name `default` is used when application code does not pass an explicit `model` option. Calling a logical name that is not configured throws an error.

See [Backends](./backends) for the full set of configuration fields supported by each backend.

### Credentials

String values in model entries support environment-variable indirection with `${VAR_NAME}` syntax, resolved at startup. Use this for API keys rather than placing the literal key in the configuration file — Harper logs a warning at startup when a credential field contains a literal value. If the referenced environment variable is unset, the placeholder is left as-is; for credential fields the backend rejects the unresolved placeholder at startup, while other fields (such as `host` or `model`) carry the literal placeholder into requests — surfacing as per-request failures rather than a startup error. Indirection applies to string-typed fields only; numeric fields such as `requestTimeoutMs` must be literal values.

### Startup behavior

Model entries are registered when Harper boots, before components load, so `models` is usable from component initialization onward.

Model entries are validated with the rest of the configuration file at startup: a structurally invalid entry — a missing required field such as `apiKey`, an unrecognized field name, or a wrong value type — fails configuration validation and prevents Harper from starting, like any other configuration error. Errors at registration time (for example, an unrecognized `backend` name) are logged and skipped without blocking startup or other model entries.
