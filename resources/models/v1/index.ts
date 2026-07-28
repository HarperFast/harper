/**
 * `/v1/*` OpenAI-compatible gateway (#631).
 *
 * Registers three REST resources on the REST port:
 *   POST /v1/embeddings          → V1Embeddings
 *   POST /v1/chat/completions    → V1ChatCompletions
 *   GET  /v1/models              → V1Models
 *
 * Off by default, and `defaultConfig.yaml` deliberately ships no `modelsGateway`
 * block: with the key absent the root loader skips the component before resolving
 * it, so none of this module graph is imported on an instance that does not use
 * the gateway. Opt in by adding the block to `harperdb-config.yaml` with
 * `enabled: true`, or via `set_configuration` (`modelsGateway_enabled`).
 * `enabled: false` is honored too, for an instance that wants the block present
 * but inert — that costs the import, which is why it is not the shipped default.
 *
 * Example (opt in). `rest` is required: these are REST-served resources and the
 * gateway deliberately does not force REST to start (see `handleApplication`).
 * Without it the resources register but every `/v1/*` path 404s.
 *
 * ```yaml
 * rest: true
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
import harperLogger from '../../../utility/logging/harper_logger.ts';
import { getConfigObj } from '../../../config/configUtils.ts';
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
	//
	// Warn rather than fail: an app loaded later may still declare `rest`, so absence here
	// is not conclusive. But defaultConfig ships no `rest` section, so enabling the gateway
	// alone yields three registered resources and a 404 on every /v1 path — worth a line in
	// the log instead of silence.
	const rootConfig = getConfigObj() as Record<string, unknown> | undefined;
	if (rootConfig && !rootConfig.rest && !rootConfig.REST) {
		harperLogger.warn(
			'modelsGateway is enabled but no `rest` section is configured; /v1/* endpoints are only served when REST is active'
		);
	}
	scope.resources.set('v1/models', V1Models);
	scope.resources.set('v1/embeddings', V1Embeddings);
	scope.resources.set('v1/chat/completions', V1ChatCompletions);
}
