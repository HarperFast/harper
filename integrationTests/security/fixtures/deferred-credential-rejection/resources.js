import { credentialRejectionError } from 'harper';

export class PublicNotice extends tables.PublicNotice {
	allowRead() {
		return true;
	}
}

<<<<<<< HEAD
export const REJECTED_SESSION_USER = 'expired-staff';
export const FAULTING_SESSION_USER = 'faulting-staff';
=======
const REJECTED_SESSION_USER = 'expired-staff';
const FAULTING_SESSION_USER = 'faulting-staff';
// a real hdb_user (the suite creates it) that this component's server.getUser refuses
const BLOCKED_USER = 'blocked-staff';

// Per-username count of server.getUser calls; the suite runs one thread so this is the whole server's.
const getUserCalls = new Map();
export class GetUserCalls extends Resource {
	allowRead() {
		return true;
	}
	get(target) {
		return { calls: getUserCalls.get(target.id) ?? 0 };
	}
}
>>>>>>> 0974ce0db (Settle deferred credential rejections on legacy Fastify routes and challenge every authentication 401)

const coreGetUser = server.getUser;
server.getUser = async function (username, password, request) {
	getUserCalls.set(username, (getUserCalls.get(username) ?? 0) + 1);
	if (username.startsWith(REJECTED_SESSION_USER)) throw credentialRejectionError('SSO session expired', 401);
	if (username === FAULTING_SESSION_USER) throw new Error('user store unavailable');
	if (username === BLOCKED_USER) throw credentialRejectionError('Account blocked', 401);
	return coreGetUser.call(this, username, password, request);
};
