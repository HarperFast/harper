// A server.getUser override that builds a principal from an opaque token sent as the MQTT password.
// The token names an hdb_role; the override resolves that role record at login and builds a user
// with no hdb_user record behind it (the "recordless" principal PR #4071 keeps through rechecks).
const { Feed, Gate } = tables;
const PREFIX = 'sqa157:';
const coreGetUser = server.getUser;

function findRoleByName(name) {
	const roleTable = databases.system?.hdb_role;
	if (!roleTable) throw new Error('sqa157: databases.system.hdb_role is not declared');
	for (const { value } of roleTable.primaryStore.getRange({ start: false })) {
		if (value?.role === name) return value;
	}
	return undefined;
}

server.getUser = async function (username, password) {
	if (typeof password === 'string' && password.startsWith(PREFIX)) {
		const claims = JSON.parse(Buffer.from(password.slice(PREFIX.length), 'base64url').toString('utf8'));
		if (typeof claims.role !== 'string') throw new Error('sqa157: token names no role');
		const record = findRoleByName(claims.role);
		if (!record) throw new Error(`sqa157: no hdb_role named ${claims.role}`);
		const user = {
			username,
			active: true,
			role: { id: record.id, role: record.role, permission: record.permission },
		};
		if (typeof claims.exp === 'number') user.authExpiresAt = claims.exp;
		return user;
	}
	return coreGetUser.call(server, username, password);
};

// The docs' revocable-grant route: an allowRead composed with super.allowRead that reads revocation state.
export class GatedFeed extends Feed {
	async allowRead(user, target, context) {
		const gate = await Gate.get(user.username);
		if (gate?.revoked === true) return false;
		return super.allowRead(user, target, context);
	}
}
