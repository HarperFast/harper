// Produces request-driven log volume from the HTTP workers, which is where the load that makes
// logging.rotation.maxSize matter is actually written (#1877).
import { threadId } from 'node:worker_threads';

const LINES_PER_REQUEST = 20;
const PADDING = 'p'.repeat(200);

export class LogBurst extends Resource {
	async get() {
		const marker = this.getId();
		for (let i = 0; i < LINES_PER_REQUEST; i++) {
			logger.notify(`rotation-marker ${marker}:${i} ${PADDING}`);
		}
		return { marker, threadId, lines: LINES_PER_REQUEST };
	}
}
