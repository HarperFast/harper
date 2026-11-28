import { setTimeout as sleep } from 'node:timers/promises';

const VERSION = 1;

export class SlowVersion extends Resource {
	static loadAsInstance = false;
	async get() {
		await sleep(250);
		return { version: VERSION };
	}
}
