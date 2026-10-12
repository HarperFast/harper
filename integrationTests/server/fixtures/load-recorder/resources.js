import { Resource } from 'harper';
import { appendFileSync } from 'node:fs';
import { threadId, workerData } from 'node:worker_threads';

// One line per thread that loads this application.
appendFileSync(new URL('./loads.log', import.meta.url), `${workerData?.name ?? 'main'} ${threadId}\n`);

export class LoadRecorder extends Resource {
	get() {
		return { threadId };
	}
}
