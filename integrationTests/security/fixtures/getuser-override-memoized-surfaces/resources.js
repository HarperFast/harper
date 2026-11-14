// A memoizing server.getUser override (one principal object per username, handed to every later lookup —
// the shape PR #4071's "memoizing server.getUser" commit names) reached through THREE login paths:
//   - MQTT / HTTP Basic: the password is an opaque `sqa166:<base64url json>` token carrying a shared secret
//     and the hdb_role whose permission the principal copies;
//   - a component Bearer validator (`server.registerBearerValidator`): an `Authorization: Bearer sqa166bv.<base64url json>`
//     token with the same claims; the validator returns `{ username }` and Harper then calls
//     `server.getUser(username, null, request)`, which this override answers from the memo (or builds the entry
//     from the role the validator stashed for that username).
// The suite also creates an hdb_user record under each username, so the principal is record-backed at its
// first login and the documented drop_user / deactivate / role-move revocation applies to it.
const PREFIX = 'sqa166:';
const BEARER_PREFIX = 'sqa166bv.';
const SECRET = 'open-sesame';
const coreGetUser = server.getUser;
const memo = new Map();
const pendingRoles = new Map();

function findRoleByName(name) {
	const roleTable = databases.system?.hdb_role;
	if (!roleTable) throw new Error('sqa166: databases.system.hdb_role is not declared');
	for (const { value } of roleTable.primaryStore.getRange({ start: false })) {
		if (value?.role === name) return value;
	}
	return undefined;
}

function decodeClaims(encoded) {
	const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
	if (claims.secret !== SECRET) throw new Error('sqa166: bad secret');
	if (typeof claims.role !== 'string') throw new Error('sqa166: token names no role');
	return claims;
}

function memoizedPrincipal(username, roleName) {
	let user = memo.get(username);
	if (!user) {
		const record = findRoleByName(roleName);
		if (!record) throw new Error(`sqa166: no hdb_role named ${roleName}`);
		user = { username, active: true, role: { id: record.id, role: record.role, permission: record.permission } };
		memo.set(username, user);
	}
	return user;
}

server.getUser = async function (username, password, request) {
	if (typeof password === 'string' && password.startsWith(PREFIX)) {
		const claims = decodeClaims(password.slice(PREFIX.length));
		return memoizedPrincipal(username, claims.role);
	}
	if (password === null && (memo.has(username) || pendingRoles.has(username))) {
		const roleName = pendingRoles.get(username);
		pendingRoles.delete(username);
		return memoizedPrincipal(username, roleName);
	}
	return coreGetUser.call(server, username, password, request);
};

server.registerBearerValidator(async (token) => {
	if (typeof token !== 'string' || !token.startsWith(BEARER_PREFIX)) return undefined;
	const claims = decodeClaims(token.slice(BEARER_PREFIX.length));
	if (typeof claims.username !== 'string') throw new Error('sqa166: bearer token names no username');
	pendingRoles.set(claims.username, claims.role);
	return { username: claims.username, authExpiresAt: Math.floor(Date.now() / 1000) + 600 };
});

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
