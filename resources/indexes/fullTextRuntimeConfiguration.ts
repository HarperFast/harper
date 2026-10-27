import { getEnvironmentData, isMainThread, setEnvironmentData, workerData } from 'node:worker_threads';
import * as env from '../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';
import { ServerError } from '../../utility/errors/hdbError.ts';

const configurationKey = 'harper.fullTextRuntimeConfiguration';
let snapshot: { runtime: unknown } | undefined =
	workerData?.fullTextRuntimeConfiguration ?? getEnvironmentData(configurationKey);

export class FullTextWorkerInitializationError extends ServerError {
	readonly retryable = false;
	constructor() {
		super('Initialize Harper before creating application workers that use full-text search');
		this.name = 'FullTextWorkerInitializationError';
	}
}

export function getFullTextRuntimeConfiguration(required?: true): Readonly<{ runtime: unknown }>;
export function getFullTextRuntimeConfiguration(required: false): Readonly<{ runtime: unknown }> | undefined;
export function getFullTextRuntimeConfiguration(required = true): Readonly<{ runtime: unknown }> | undefined {
	if (!snapshot) {
		if (!isMainThread) {
			if (required) throw new FullTextWorkerInitializationError();
			return;
		}
		snapshot = { runtime: structuredClone(env.get(CONFIG_PARAMS.STORAGE_FULL_TEXT_RUNTIME)) };
		setEnvironmentData(configurationKey, snapshot);
	}
	if (snapshot.runtime && typeof snapshot.runtime === 'object') Object.freeze(snapshot.runtime);
	return Object.freeze(snapshot);
}
