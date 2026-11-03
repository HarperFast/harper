import { Resource } from 'harper';

const describePeer = (user, ip) => ({
	username: user?.username ?? null,
	localMarker: user?._localPrincipal === true,
	ip: ip ?? null,
});

export class WhoAmI extends Resource {
	static loadAsInstance = false;
	allowRead() {
		return true;
	}
	get() {
		const context = this.getContext();
		return describePeer(context?.user, context?.ip);
	}
	static async *connect(_target, _incomingMessages, request) {
		yield describePeer(request?.user, request?.ip);
	}
}
