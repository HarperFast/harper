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
	static get(_target: unknown, _request: unknown): OAIModelList {
		const created = Math.floor(Date.now() / 1000);
		const generative = listBackends('generative').map(
			({ logicalName }): OAIModelEntry => ({
				id: logicalName,
				object: 'model',
				created,
				owned_by: 'harper',
			})
		);
		const embedding = listBackends('embedding').map(
			({ logicalName }): OAIModelEntry => ({
				id: logicalName,
				object: 'model',
				created,
				owned_by: 'harper',
			})
		);
		return { object: 'list', data: [...generative, ...embedding] };
	}
}
