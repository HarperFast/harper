import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { threadId } from 'node:worker_threads';

const child = fork(fileURLToPath(new URL('./child.cjs', import.meta.url)), [], {
	name: 'identity-sidecar',
	stdio: 'ignore',
});

export class NamedProcess extends Resource {
	static loadAsInstance = false;
	allowRead() {
		return true;
	}
	get() {
		return { pid: child.pid, threadId };
	}
}
