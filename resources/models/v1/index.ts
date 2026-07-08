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
	// TEMP #1616-debug (revert before merge)
	console.error(`[1616-debug] modelsGateway handleApplication enabled=${JSON.stringify(scope.options.get(['enabled']))}`);
	if (!scope.options.get(['enabled'])) return;
	scope.resources.set('v1/models', V1Models);
	scope.resources.set('v1/embeddings', V1Embeddings);
	scope.resources.set('v1/chat/completions', V1ChatCompletions);
}
