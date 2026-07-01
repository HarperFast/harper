---
id: routing
title: Routing & Fallback
---

<!-- Source: harper resources/models/routing.ts, resources/models/Models.ts, resources/models/bootstrap.ts, resources/models/types.ts (v5.1.15) -->

<VersionBadge version="v5.1.15" />

Every `models` call resolves through a **router** that returns an ordered list of candidate backends for the requested logical name. The facade uses the first candidate whose capabilities satisfy the call and falls through to the next on failure — capability-aware selection and fallback are the same mechanism.

By default the router is a name-lookup + capability filter over a logical name's [fallback group](#fallback-groups). A component can replace it with [`models.registerRouter()`](#custom-routers) for cost-, latency-, or tenant-aware policies.

## Fallback groups

A model entry can name other logical models to try, in order, after itself. Configure the group with `fallback` in the [models configuration](./overview#configuration):

```yaml
models:
  generative:
    default:
      backend: openai
      model: gpt-4o-mini
      fallback: [local-llama] # try `default`, then `local-llama`
    local-llama:
      backend: ollama
      model: llama3.2
```

A call to the `default` model tries `openai` first; if it fails, the call falls through to `local-llama`. The group is `[default, ...fallback]`, de-duplicated and in order. Groups are rebuilt on every configuration reload, so removing a `fallback` takes effect on the next reload.

## Capability routing

A call can require capabilities of the backend it lands on. The router keeps only the candidates whose `capabilities()` satisfy the requirement, in group order.

- **`opts.requires`** — an explicit list of capabilities (`embed`, `generate`, `stream`, `tools`, `adapters`).
- **Tools auto-require `tools`** — a `generate()` call whose input carries a `tools` array routes to a tools-capable candidate in the group instead of erroring on a backend that can't do tools.

```javascript
// Tools in the input auto-route to a tools-capable candidate in the group:
const reply = await models.generate(
	{ messages: [{ role: 'user', content: 'What is the weather?' }], tools: [weatherTool] },
	{ model: 'default' }
);

// Or require a capability explicitly:
const reply = await models.generate('…', { model: 'default', requires: ['tools'] });
```

If no candidate in the group satisfies the required capabilities, the call throws a capability error naming the primary backend — no request is made.

## Fallback on error

When a candidate fails, `embed` / `generate` record the attempt and try the next candidate. Every attempt — success or failure — is written to [model-call analytics](./analytics), so a fallthrough is observable.

- **Any backend error falls through** to the next candidate. Candidates are heterogeneous — a limit or input error on one backend may succeed on another with different constraints — so whether an error is "worth a fallback" is a router or caller policy, not a facade default.
- **A caller abort short-circuits.** If the call's `signal` is already aborted, the loop stops and surfaces the abort rather than spending another backend call.
- **The primary error is surfaced.** If every candidate fails, the error thrown is the **first (primary)** candidate's — the model you asked for, and usually the most diagnostic — not the last fallback's.

`generateStream` resolves to the **first** candidate only. There is no mid-stream fallback: once chunks have been yielded, switching backends would mean replaying already-delivered output.

## Custom routers

Replace the default policy with `models.registerRouter()`. A router is a single **synchronous** `route()` method that returns the ordered candidate backends for a request; an empty array means "no candidate."

```typescript
models.registerRouter(router: ModelRouter): void

interface ModelRouter {
	route(req: RouteRequest): ModelBackend[];
}

interface RouteRequest {
	kind: 'embedding' | 'generative';
	logicalName: string; // from opts.model; defaults to 'default'
	requires: Capability[]; // capabilities the chosen backend must satisfy
	hints?: Record<string, unknown>; // free-form (tenant, prompt size, …) for custom policies
}
```

`route()` is synchronous so the facade keeps its up-front resolution errors (notably `generateStream`'s synchronous throw for an unknown model). A registered router **fully replaces** the default — it is responsible for every `kind` and logical name it should serve. Register during component initialization; the override is process-wide and one router serves the whole process (last registration wins), so it is a deployment/application control rather than something independent components should each set.

```javascript
import { models } from 'harper';

// Backends this policy chooses among (or capture already-registered ones):
const fast = models.defineBackend({ name: 'fast', generate: generateFast });
const cheap = models.defineBackend({ name: 'cheap', generate: generateCheap });

models.registerRouter({
	route({ kind, requires, hints }) {
		if (kind !== 'generative') return []; // this policy only routes generation
		// e.g. prefer the cheap backend for small prompts, the fast one otherwise:
		const order = hints?.small ? [cheap, fast] : [fast, cheap];
		return order.filter((b) => requires.every((cap) => b.capabilities()[cap]));
	},
});
```

A custom router that returns no candidates for a backend that _does_ satisfy the requirement surfaces a plain "no routing candidates available" error — not a misleading capability error against a backend that actually supports the call.
