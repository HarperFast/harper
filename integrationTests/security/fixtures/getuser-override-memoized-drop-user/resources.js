// A memoizing server.getUser override: one principal object per username, handed to every later lookup
// (the shape PR #4071's "memoizing server.getUser" commit names). The password is an opaque
// `sqa165:<base64url json>` token carrying a shared secret and the hdb_role to copy permissions from.
// The suite also creates an hdb_user record under each username, so the principal is record-backed at
// its first login and the documented drop_user revocation applies to it.
const PREFIX = 'sqa165:';
const SECRET = 'open-sesame';
const coreGetUser = server.getUser;
const memo = new Map();

function findRoleByName(name) {
	const roleTable = databases.system?.hdb_role;
	if (!roleTable) throw new Error('sqa165: databases.system.hdb_role is not declared');
	for (const { value } of roleTable.primaryStore.getRange({ start: false })) {
		if (value?.role === name) return value;
	}
	return undefined;
}

server.getUser = async function (username, password, request) {
	if (typeof password === 'string' && password.startsWith(PREFIX)) {
		const claims = JSON.parse(Buffer.from(password.slice(PREFIX.length), 'base64url').toString('utf8'));
		if (claims.secret !== SECRET) throw new Error('sqa165: bad secret');
		if (typeof claims.role !== 'string') throw new Error('sqa165: token names no role');
		let user = memo.get(username);
		if (!user) {
			const record = findRoleByName(claims.role);
			if (!record) throw new Error(`sqa165: no hdb_role named ${claims.role}`);
			user = { username, active: true, role: { id: record.id, role: record.role, permission: record.permission } };
			memo.set(username, user);
		}
		return user;
	}
	return coreGetUser.call(server, username, password, request);
};

// Reports which object the memo holds, so the suite can show the HTTP and MQTT logins shared one principal.
export class MemoState extends Resource {
	allowRead(user) {
		return user?.role?.permission?.super_user === true;
	}
	get(query) {
		const username = query.get('username');
		return { username, memoized: memo.has(username) };
	}
}
