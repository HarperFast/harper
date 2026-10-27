// Answers get_studio_configuration on a worker thread, where the operations API does not run.
import { isMainThread } from 'node:worker_threads';

export class StudioFromWorker extends Resource {
	allowRead() {
		return true;
	}
	async get() {
		const configuration = await server.operation({ operation: 'get_studio_configuration' }, this.getContext(), true);
		return { isMainThread, configuration };
	}
}
