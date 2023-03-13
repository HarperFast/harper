import { findAndValidateUser } from './user';
import { validateOperationToken } from './tokenAuthentication';

let authorization_cache = new Map();
const AUTHORIZATION_TTL = 5000;
// TODO: Make this not return a promise if it can be fulfilled synchronously (from cache)
async function authentication(request) {
	let headers = request.headers;
	let authorization = headers.authorization;
	// TODO: Need to implement support for cookie handling of auth
	// let cookie = headers.cookie;
	// let auth_cookie = cookie?.match(/(^|\s|;)auth=([^;]+)/)
	if (authorization) {
		let user = authorization_cache.get(authorization);
		if (!user) {
			let [ strategy, credentials ] = authorization.split(' ');
			switch (strategy) {
				case 'Basic':
					let [ username, password ] = atob(credentials).split(':');
					user = await findAndValidateUser(username, password);
					break;
				case 'Bearer':
					user = await validateOperationToken(credentials);
					break;
			}
			authorization_cache.set(authorization, user);
		}
		request.user = user;
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
