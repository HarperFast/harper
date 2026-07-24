/**
 * `/v1/*` OpenAI-compatible gateway (#631).
 *
 * Registers three REST resources on the REST port:
 *   POST /v1/embeddings          → V1Embeddings
 *   POST /v1/chat/completions    → V1ChatCompletions
 *   GET  /v1/models              → V1Models
 *
 * Off by default. Opt in by setting `enabled: true` in the `modelsGateway`
 * block of `harperdb-config.yaml`. Opt out explicitly with `enabled: false`.
 * This mirrors the `agent` component's enabled-flag pattern.
 *
 * Example (opt in):
 *
 * ```yaml
 * modelsGateway:
 *   enabled: true
 * models:
 *   generative:
 *     default:
 *       backend: ollama
 *       model: llama3.2
 * ```
 *
 * All three endpoints require `super_user` permission. Anonymous or
 * insufficient-privilege requests receive a well-formed OpenAI error envelope.
 */

import type { Scope } from '../../../components/Scope.ts';
import { V1Embeddings } from './embeddings.ts';
import { V1ChatCompletions } from './chatCompletions.ts';
import { V1Models } from './models.ts';

export function handleApplication(scope: Scope): void {
	if (!scope.options.get(['enabled'])) return;
	// These resources are served by REST's middleware chain, so the instance must also
	// have a `rest`/`REST` config section — the gateway deliberately does NOT force REST
	// to start. Doing so requires reaching into REST's module state before application
	// configs have loaded, which silently discards an app's own `rest` options (webSocket,
	// urlPath/host, middleware ordering). Core has no supported way yet for a component to
	// declare "I serve REST resources"; that gap is tracked separately.
	scope.resources.set('v1/models', V1Models);
	scope.resources.set('v1/embeddings', V1Embeddings);
	scope.resources.set('v1/chat/completions', V1ChatCompletions);
}
