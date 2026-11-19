import { Resource } from 'harper';
import { getCompileCacheDir } from 'node:module';
import { threadId } from 'node:worker_threads';

export class CompileCacheProbe extends Resource {
	get() {
		return { threadId, cacheDirectory: getCompileCacheDir?.() ?? null };
	}
}
