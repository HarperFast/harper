import { findAndValidateUser, getSuperUser } from './user';
import { server } from '../server/Server';
import { validateOperationToken } from './tokenAuthentication';
import { table } from '../resources/tableLoader';
import { v4 as uuid } from 'uuid';

server.auth = findAndValidateUser;
let session_table = table({
	table: 'hdb_session',
	database: 'system',
	attributes: [{ name: 'id', is_primary_key: true }],
});

let authorization_cache = new Map();
const AUTHORIZATION_TTL = 5000;
const AUTHORIZE_LOCAL = true;
// TODO: Make this not return a promise if it can be fulfilled synchronously (from cache)
async function authentication(request) {
	const headers = request.headers;
	const authorization = headers.authorization;
	const cookie = headers.cookie;
	let session_id = cookie?.match(/(^|\s|;)hdb-session=(\w+)/)?.[2];
	let session;
	if (session_id) {
		if (session_table.then) session_table = await session_table;
		session = session_table.get(session_id);
	}
	request.session = session;
	request.user = session?.user;
	let new_user;
	if (authorization) {
		let new_user = authorization_cache.get(authorization);
		if (!new_user) {
			const [strategy, credentials] = authorization.split(' ');
			switch (strategy) {
				case 'Basic':
					const [username, password] = atob(credentials).split(':');
					new_user = await server.auth(username, password);
					break;
				case 'Bearer':
					new_user = await validateOperationToken(credentials);
					break;
			}
			authorization_cache.set(authorization, new_user);
		}
		request.user = new_user;
	} else {
		if (AUTHORIZE_LOCAL && request.socket.remoteAddress.includes('127.0.0.1')) {
			request.user = new_user = await getSuperUser();
		}
	}
	if ((new_user && !session) || session.user?.username !== new_user?.username) {
		const new_session = !session_id;
		if (new_session) {
			session_id = uuid();
		}
		if (session_table.then) session_table = await session_table;
		const session_saved = session_table.put(session_id, { user: request.user.username });
		request.onResponse = (response) => {
			if (new_session) response.headers.append('set-cookie', `hdb-session=${session_id}; Secure`);
			return session_saved;
		};
	}
}
exports.authentication = authentication;
exports.start = function ({ server, port }) {
	server.request(
		(request, next_handler) => {
			return authentication(request).then(() => next_handler(request));
		},
		{ port: port || 'all-http' }
	);
	// keep it cleaned out periodically
	setInterval(() => {
		authorization_cache = new Map();
	}, AUTHORIZATION_TTL);
};
