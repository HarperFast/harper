import { findAndValidateUser, getSuperUser } from './user';
import { server } from '../server/Server';
import { resources } from '../resources/Resources';
import { validateOperationToken, validateRefreshToken } from './tokenAuthentication';
import { table } from '../resources/databases';
import { v4 as uuid } from 'uuid';
import * as env from '../utility/environment/environmentManager';
import { CONFIG_PARAMS, AUTH_AUDIT_STATUS, AUTH_AUDIT_TYPES } from '../utility/hdbTerms';
import { loggerWithTag, AuthAuditLog } from '../utility/logging/harper_logger.js';
import { serializeMessage } from '../server/serverHelpers/contentTypes';
const auth_event_log = loggerWithTag('auth-event');
env.initSync();

const props_cors_accesslist = env.get(CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_CORSACCESSLIST);
const props_cors = env.get(CONFIG_PARAMS.CUSTOMFUNCTIONS_NETWORK_CORS);

server.auth = findAndValidateUser;
let session_table = table({
	table: 'hdb_session',
	database: 'system',
	attributes: [{ name: 'id', isPrimaryKey: true }],
});

let authorization_cache = new Map();
// TODO: Make this not return a promise if it can be fulfilled synchronously (from cache)
export async function authentication(request, next_handler) {
	const headers = request.headers;
	const authorization = headers.authorization;
	const cookie = headers.cookie;
	const origin = headers.origin;
	const response_headers = [];
	if ((origin && props_cors && props_cors_accesslist.includes(origin)) || props_cors_accesslist.includes('*')) {
		response_headers.push('Access-Control-Allow-Origin', origin);
		if (env.get(CONFIG_PARAMS.AUTHENTICATION_ENABLESESSIONS))
			response_headers.push('Access-Control-Allow-Credentials', 'true');
		if (request.method === 'OPTIONS') {
			// preflight request
			response_headers.push('Access-Control-Allow-Method', 'POST, GET, PUT, DELETE, PATCH, OPTIONS');
			response_headers.push('Access-Control-Allow-Headers', 'Accept', 'Content-Type', 'Authorization');
		}
	}
	let session_id;
	let session;
	if (env.get(CONFIG_PARAMS.AUTHENTICATION_ENABLESESSIONS)) {
		// we prefix the cookie name with the origin so that we can partition/separate session/authentications
		// host, to protect against CSRF
		const cookie_prefix = (origin ? '' : origin + '-') + 'hdb-session=';
		const cookie_start = cookie?.indexOf(cookie_prefix);
		if (cookie_start >= 0) {
			const end = cookie.indexOf(';', cookie_start);
			session_id = cookie.slice(cookie_start, end === -1 ? cookie.length : end);
			if (session_table.then) session_table = await session_table;
			session = session_table.get(session_id);
		}
		request.session = session || (session = {});
	}
	request.user = null;

	const authAuditLog = (username, status, strategy) => {
		const log = new AuthAuditLog(
			username,
			status,
			AUTH_AUDIT_TYPES.AUTHENTICATION,
			request.headers['x-forwarded-for'] ?? request.ip,
			request.method,
			request.pathname
		);
		log.auth_strategy = strategy;
		if (session_id) log.session_id = session_id;
		if (request.headers['referer']) log.referer = request.headers['referer'];
		if (request.headers['origin']) log.origin = request.headers['origin'];

		if (status === AUTH_AUDIT_STATUS.SUCCESS) auth_event_log.notify(log);
		else auth_event_log.error(log);
	};

	let new_user;
	if (authorization) {
		let new_user = authorization_cache.get(authorization);
		if (!new_user) {
			const [strategy, credentials] = authorization.split(' ');
			let username, password;
			try {
				switch (strategy) {
					case 'Basic':
						[username, password] = atob(credentials).split(':');
						// legacy support for passing in blank username and password to indicate no auth
						new_user = username || password ? await server.auth(username, password) : null;
						break;
					case 'Bearer':
						try {
							new_user = await validateOperationToken(credentials);
						} catch (error) {
							if (error.message === 'invalid token') {
								// see if they provided a refresh token; we can allow that and pass it on to operations API
								try {
									new_user = await validateRefreshToken(credentials);
									return {
										// we explicitly declare we don't want to handle this because the operations
										// API has its own logic for handling this
										status: -1,
									};
								} catch (refresh_error) {
									throw error;
								}
							}
						}
						break;
				}
			} catch (err) {
				if (env.get(CONFIG_PARAMS.LOGGING_AUDITAUTHEVENTS_LOGFAILED)) {
					const failed_attempt = authorization_cache.get(credentials);
					if (!failed_attempt) {
						authorization_cache.set(credentials, credentials);
						authAuditLog(username, AUTH_AUDIT_STATUS.FAILURE, strategy);
					}
				}

				return {
					status: 401,
					body: serializeMessage({ error: err.message }, request),
				};
			}

			authorization_cache.set(authorization, new_user);
			if (env.get(CONFIG_PARAMS.LOGGING_AUDITAUTHEVENTS_LOGSUCCESSFUL))
				authAuditLog(new_user.username, AUTH_AUDIT_STATUS.SUCCESS, strategy);
		}

		request.user = new_user;
	} else if (session?.user) {
		// or should this be cached in the session?
		request.user = await server.auth(session.user);
	} else if (
		env.get(CONFIG_PARAMS.AUTHENTICATION_AUTHORIZELOCAL) &&
		(request.ip.includes('127.0.0.1') || request.ip == '::1')
	) {
		request.user = new_user = await getSuperUser();
	}
	if (env.get(CONFIG_PARAMS.AUTHENTICATION_ENABLESESSIONS)) {
		request.session.update = async function (updated_session) {
			if (!session_id) {
				session_id = uuid();
				response_headers.push(
					'set-cookie',
					`hdb-session=${session_id}; Path=/; Expires=Tue, 01 Oct 8307 19:33:20 GMT; HttpOnly; Partitioned${
						request.protocol === 'https' ? '; Secure' : ''
					}`
				);
			}
			if (session_table.then) session_table = await session_table;
			updated_session.id = session_id;
			session_table.put(updated_session);
		};
		request.login = async function (user, password) {
			request.user = await server.auth(user, password);
			request.session.update({ user: request.user.username });
		};
		if (
			((new_user && !session) || session?.user?.username !== new_user?.username) && // new session or change in session
			headers['user-agent']?.startsWith('Mozilla') // only auto-set cookies and create sessions on web browsers
		) {
			request.session.update({ user: request.user.username });
		}
	}
	const response = await next_handler(request);
	if (!response) return response;
	if (response.status === 401) {
		if (
			headers['user-agent']?.startsWith('Mozilla') &&
			headers.accept?.startsWith('text/html') &&
			resources.loginPath
		) {
			// on the web if we have a login page, default to redirecting to it
			response.status = 302;
			response.headers.Location = resources.loginPath(request);
		} // the HTTP specified way of indicating HTTP authentication methods supported:
		else response.headers['WWW-Authenticate'] = 'Basic';
	}
	const l = response_headers.length;
	if (l > 0) {
		let headers = response.headers;
		if (!headers) response.headers = headers = {};
		for (let i = 0; i < l; ) {
			const name = response_headers[i++];
			const value = response_headers[i++];
			headers[name] = value;
		}
	}
	return response;
}
export function start({ server, port }) {
	server.request(authentication, { port: port || 'all-http' });
	// keep it cleaned out periodically
	setInterval(() => {
		authorization_cache = new Map();
	}, env.get(CONFIG_PARAMS.AUTHENTICATION_CACHETTL)).unref();
}
