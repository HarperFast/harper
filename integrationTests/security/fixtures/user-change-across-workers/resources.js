import { threadId } from 'node:worker_threads';

export class WhoAmI extends Resource {
	static loadAsInstance = false;
	allowRead() {
		return true;
	}
	get() {
		const user = this.getContext()?.user;
		return { threadId, username: user?.username ?? null, superUser: user?.role?.permission?.super_user === true };
	}
}
