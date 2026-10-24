import { Resource } from 'harper';

export class UncaughtFault extends Resource {
	get() {
		setTimeout(() => {
			throw new Error('QA372-UNCAUGHT-PRIVATE request-token=synthetic');
		}, 10);
		return { queued: true };
	}
}
