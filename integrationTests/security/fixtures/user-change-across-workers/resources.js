import { threadId } from 'node:worker_threads';

// Which worker served the request, and the principal authentication resolved there
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
