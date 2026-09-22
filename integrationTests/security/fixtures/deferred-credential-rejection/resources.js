import { credentialRejectionError } from 'harper';

export class PublicNotice extends tables.PublicNotice {
	allowRead() {
		return true;
	}
}

export const REJECTED_SESSION_USER = 'expired-staff';
export const FAULTING_SESSION_USER = 'faulting-staff';

const coreGetUser = server.getUser;
server.getUser = async function (username, password, request) {
	if (username === REJECTED_SESSION_USER) throw credentialRejectionError('SSO session expired', 401);
	if (username === FAULTING_SESSION_USER) throw new Error('user store unavailable');
	return coreGetUser.call(this, username, password, request);
};
