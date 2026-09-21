import { credentialRejectionError } from 'harper';

export class PublicNotice extends tables.PublicNotice {
	allowRead() {
		return true;
	}
}

// #2703: a component gating cookie sessions through the documented `server.getUser` extension
// point. `credentialRejectionError` is imported from the public package on purpose — that import
// is what proves the tag an override needs is actually reachable from a component.
export const REJECTED_SESSION_USER = 'expired-staff';
export const FAULTING_SESSION_USER = 'faulting-staff';

const coreGetUser = server.getUser;
server.getUser = async function (username, password, request) {
	if (username === REJECTED_SESSION_USER) throw credentialRejectionError('SSO session expired', 401);
	if (username === FAULTING_SESSION_USER) throw new Error('user store unavailable');
	return coreGetUser.call(this, username, password, request);
};
