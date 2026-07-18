/**
 * `GET /v1/models` — OpenAI-compatible model list endpoint (#631).
 *
 * Enumerates all registered embedding and generative backends from the
 * process-wide `backendRegistry`. The response mirrors the OpenAI shape:
 * `{ object: 'list', data: [{ id, object: 'model', created, owned_by }] }`.
 *
 * `logicalName` (not `backend.name`) is the `id` — it's what callers pass as
 * `model` in subsequent requests.
 */

import { Resource } from '../../Resource.ts';
import { listBackends } from '../backendRegistry.ts';
import { authorizeV1Request, type OpenAIErrorResponse } from './errors.ts';

export interface OAIModelEntry {
	id: string;
	object: 'model';
	created: number;
	owned_by: string;
}

export interface OAIModelList {
	object: 'list';
	data: OAIModelEntry[];
}

// @ts-ignore — Resource base class is not typed for static dispatch; pattern mirrors login.ts
export class V1Models extends Resource {
	static get(_target: unknown, request: unknown): OAIModelList | OpenAIErrorResponse {
		const authError = authorizeV1Request(request as any);
		if (authError) return authError;

		const created = Math.floor(Date.now() / 1000);
		// OpenAI model ids are unique; a logical name registered for both generative and
		// embedding (e.g. `default` in each section) is one model id to callers.
		const ids = new Set<string>();
		const data: OAIModelEntry[] = [];
		for (const kind of ['generative', 'embedding'] as const) {
			for (const { logicalName } of listBackends(kind)) {
				if (ids.has(logicalName)) continue;
				ids.add(logicalName);
				data.push({ id: logicalName, object: 'model', created, owned_by: 'harper' });
			}
		}
		return { object: 'list', data };
	}
}
