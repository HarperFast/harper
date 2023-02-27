const { server } = require('../index');
const { findAndValidateUser } = require('./user');

let authorization_cache = new Map();
const AUTHORIZATION_TTL = 5000;
// TODO: Make this not return a promise if it can be fulfilled synchronously (from cache)
async function authentication(request) {
	let authorization = request.headers._asObject.authorization;
	if (authorization) {
		let user = authorization_cache.get(authorization);
		if (!user) {
			let [strategy, credentials] = authorization.split(' ');
			switch (strategy) {
				case 'Basic':
					let [username, password] = atob(credentials).split(':');
					user = await findAndValidateUser(username, password);
			}
			authorization_cache.set(authorization, user);
		}
		request.user = user;
	}
}
exports.start = function (options) {
	server.http((request, next_handler) => {
		return authentication(request).then(() => next_handler(request));
	}, options.port || 'all-http');
	// keep it cleaned out periodically
	setInterval(() => {
		authorization_cache = new Map();
	}, AUTHORIZATION_TTL);
};
