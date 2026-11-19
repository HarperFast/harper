import { Resource } from 'harper';

export class QueueWork extends Resource {
	allowRead() {
		return true;
	}
	allowCreate() {
		return true;
	}
	post() {
		return this.get();
	}
	get() {
		const until = performance.now() + 10;
		while (performance.now() < until) {}
		return { ok: true };
	}
}
