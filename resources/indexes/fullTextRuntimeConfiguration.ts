import { getEnvironmentData, isMainThread, setEnvironmentData, workerData } from 'node:worker_threads';
import * as env from '../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';
import { ServerError } from '../../utility/errors/hdbError.ts';

const configurationKey = 'harper.fullTextRuntimeConfiguration';
let snapshot: { runtime: unknown } | undefined =
	workerData?.fullTextRuntimeConfiguration ?? getEnvironmentData(configurationKey);

export function getFullTextRuntimeConfiguration(): Readonly<{ runtime: unknown }> {
	if (!snapshot) {
		if (!isMainThread)
			throw new ServerError('Initialize Harper before creating application workers that use full-text search', 503);
		snapshot = { runtime: structuredClone(env.get(CONFIG_PARAMS.STORAGE_FULL_TEXT)?.runtime) };
		setEnvironmentData(configurationKey, snapshot);
	}
	if (snapshot.runtime && typeof snapshot.runtime === 'object') Object.freeze(snapshot.runtime);
	return Object.freeze(snapshot);
}
