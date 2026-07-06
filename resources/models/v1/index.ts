/**
 * `/v1/*` OpenAI-compatible gateway (#631).
 *
 * Registers three REST resources on the REST port:
 *   POST /v1/embeddings          → V1Embeddings
 *   POST /v1/chat/completions    → V1ChatCompletions
 *   GET  /v1/models              → V1Models
 *
 * Activated by adding `modelsGateway: {}` (or any truthy value) to
 * `harperdb-config.yaml`. Example:
 *
 * ```yaml
 * modelsGateway: {}
 * models:
 *   generative:
 *     default:
 *       backend: ollama
 *       model: llama3.2
 * ```
 *
 * The gateway intentionally does NOT add authentication — Harper's REST layer
 * applies auth before dispatching to any resource. Deploy behind a network
 * boundary or configure Harper's auth as appropriate.
 */

import type { Scope } from '../../../components/Scope.ts';
import { V1Embeddings } from './embeddings.ts';
import { V1ChatCompletions } from './chatCompletions.ts';
import { V1Models } from './models.ts';

export function handleApplication(scope: Scope): void {
	scope.resources.set('v1/models', V1Models);
	scope.resources.set('v1/embeddings', V1Embeddings);
	scope.resources.set('v1/chat/completions', V1ChatCompletions);
}
