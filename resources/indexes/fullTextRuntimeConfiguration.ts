import { workerData } from 'node:worker_threads';
import * as env from '../../utility/environment/environmentManager.ts';
import { CONFIG_PARAMS } from '../../utility/hdbTerms.ts';

let snapshot: { runtime: unknown } | undefined = workerData?.fullTextRuntimeConfiguration;

export function getFullTextRuntimeConfiguration(): Readonly<{ runtime: unknown }> {
	if (!snapshot) {
		snapshot = { runtime: structuredClone(env.get(CONFIG_PARAMS.STORAGE_FULL_TEXT)?.runtime) };
	}
	if (snapshot.runtime && typeof snapshot.runtime === 'object') Object.freeze(snapshot.runtime);
	return Object.freeze(snapshot);
}
