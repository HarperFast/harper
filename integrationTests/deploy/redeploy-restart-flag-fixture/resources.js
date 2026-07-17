// jsResource component used by redeploy-restart-flag.test.ts. The redeploy substitutes a
// resources.js whose VERSION differs; the test asserts the post-redeploy watcher flags
// restartRequired (harper#1817) rather than silently keeping this code live.
const VERSION = 1;

export class Version extends Resource {
	static loadAsInstance = false;
	get() {
		return { version: VERSION };
	}
}
