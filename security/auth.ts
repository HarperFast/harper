import { getSuperUser } from './user';
import { server } from '../server/Server';
import { resources } from '../resources/Resources';
import { validateOperationToken, validateRefreshToken } from './tokenAuthentication';
import { table } from '../resources/databases';
import { v4 as uuid } from 'uuid';
import * as env from '../utility/environment/environmentManager';
import { CONFIG_PARAMS, AUTH_AUDIT_STATUS, AUTH_AUDIT_TYPES } from '../utility/hdbTerms';
import { loggerWithTag, AuthAuditLog, debug } from '../utility/logging/harper_logger.js';
import { user } from '../server/itc/serverHandlers';
import { Headers } from '../server/serverHelpers/Headers';
import { convertToMS } from '../utility/common_utils';
const auth_event_log = loggerWithTag('auth-event');
env.initSync();

const apps_cors_accesslist = env.get(CONFIG_PARAMS.HTTP_CORSACCESSLIST);
const apps_cors = env.get(CONFIG_PARAMS.HTTP_CORS);
const operations_cors_accesslist = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORSACCESSLIST);
const operations_cors = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORS);

const session_table = table({
	table: 'hdb_session',
	database: 'system',
	attributes: [{ name: 'id', isPrimaryKey: true }, { name: 'user' }],
});
const ENABLE_SESSIONS = env.get(CONFIG_PARAMS.AUTHENTICATION_ENABLESESSIONS) ?? true;
// check the environment for a flag to bypass authentication (for testing) since it doesn't necessarily get set on child threads
let AUTHORIZE_LOCAL =
	process.env.AUTHENTICATION_AUTHORIZELOCAL ??
	env.get(CONFIG_PARAMS.AUTHENTICATION_AUTHORIZELOCAL) ??
	process.env.DEV_MODE;
const LOG_AUTH_SUCCESSFUL = env.get(CONFIG_PARAMS.LOGGING_AUDITAUTHEVENTS_LOGSUCCESSFUL) ?? false;
const LOG_AUTH_FAILED = env.get(CONFIG_PARAMS.LOGGING_AUDITAUTHEVENTS_LOGFAILED) ?? false;

const DEFAULT_COOKIE_EXPIRES = 'Tue, 01 Oct 8307 19:33:20 GMT';

let authorization_cache = new Map();
server.onInvalidatedUser(() => {
	// TODO: Eventually we probably want to be able to invalidate individual users
	authorization_cache = new Map();
});
export function bypassAuth() {
	AUTHORIZE_LOCAL = true;
}

// TODO: Make this not return a promise if it can be fulfilled synchronously (from cache)
export async function authentication(request, next_handler) {
	const headers = request.headers.asObject; // we cheat and use the node headers object since it is a little faster
	const authorization = headers.authorization;
	const cookie = headers.cookie;
	let origin = headers.origin;
	let response_headers = [];
	try {
		if (origin) {
			const access_list = request.isOperationsServer
				? operations_cors
					? operations_cors_accesslist
					: []
				: apps_cors
					? apps_cors_accesslist
					: [];
			if (access_list.includes(origin) || access_list.includes('*')) {
				if (request.method === 'OPTIONS') {
					const accessControlAllowHeaders =
						env.get(CONFIG_PARAMS.HTTP_CORSACCESSCONTROLALLOWHEADERS) ?? 'Accept, Content-Type, Authorization';

					// preflight request
					const headers = new Headers([
						['Access-Control-Allow-Methods', 'POST, GET, PUT, DELETE, PATCH, OPTIONS'],
						['Access-Control-Allow-Headers', accessControlAllowHeaders],
						['Access-Control-Allow-Origin', origin],
					]);
					if (ENABLE_SESSIONS) headers.set('Access-Control-Allow-Credentials', 'true');
					return {
						status: 200,
						headers,
					};
				}
				response_headers.push('Access-Control-Allow-Origin', origin);
				if (ENABLE_SESSIONS) response_headers.push('Access-Control-Allow-Credentials', 'true');
			}
		}
		let session_id;
		let session;
		if (ENABLE_SESSIONS) {
			// we prefix the cookie name with the origin so that we can partition/separate session/authentications
			// host, to protect against CSRF
			if (!origin) origin = headers.host;
			const cookie_prefix =
				(origin ? origin.replace(/^https?:\/\//, '').replace(/\W/, '_') + '-' : '') + 'hdb-session=';
			const cookies = cookie?.split(/;\s+/) || [];
			for (const cookie of cookies) {
				if (cookie.startsWith(cookie_prefix)) {
					const end = cookie.indexOf(';');
					session_id = cookie.slice(cookie_prefix.length, end === -1 ? cookie.length : end);
					session = await session_table.get(session_id);
					break;
				}
			}
			request.session = session || (session = {});
		}

		const authAuditLog = (username, status, strategy) => {
			const log = new AuthAuditLog(
				username,
				status,
				AUTH_AUDIT_TYPES.AUTHENTICATION,
				headers['x-forwarded-for'] ?? request.ip,
				request.method,
				request.pathname
			);
			log.auth_strategy = strategy;
			if (session_id) log.session_id = session_id;
			if (headers['referer']) log.referer = headers['referer'];
			if (headers['origin']) log.origin = headers['origin'];

			if (status === AUTH_AUDIT_STATUS.SUCCESS) auth_event_log.notify(log);
			else auth_event_log.error(log);
		};

		if (
			!request.authorized &&
			request.mtlsConfig &&
			request.peerCertificate.subject &&
			request?._nodeRequest?.socket?.authorizationError
		)
			auth_event_log.error('Authorization error:', request._nodeRequest.socket.authorizationError);

		if (request.mtlsConfig && request.authorized && request.peerCertificate.subject) {
			let username = request.mtlsConfig.user;
			if (username !== null) {
				// null means no user is defined from certificate, need regular authentication as well
				if (username === undefined || username === 'Common Name' || username === 'CN')
					username = request.peerCertificate.subject.CN;
				request.user = await server.getUser(username, null, request);
				authAuditLog(username, AUTH_AUDIT_STATUS.SUCCESS, 'mTLS');
			} else {
				debug('HTTPS/WSS mTLS authorized connection (mTLS did not authorize a user)', 'from', request.ip);
			}
		}

		let new_user;
		if (request.user) {
			// already authenticated
		} else if (authorization) {
			new_user = authorization_cache.get(authorization);
			if (!new_user) {
				const space_index = authorization.indexOf(' ');
				const strategy = authorization.slice(0, space_index);
				const credentials = authorization.slice(space_index + 1);
				let username, password;
				try {
					switch (strategy) {
						case 'Basic':
							const decoded = atob(credentials);
							const colon_index = decoded.indexOf(':');
							username = decoded.slice(0, colon_index);
							password = decoded.slice(colon_index + 1);
							// legacy support for passing in blank username and password to indicate no auth
							new_user = username || password ? await server.getUser(username, password, request) : null;
							break;
						case 'Bearer':
							try {
								new_user = await validateOperationToken(credentials);
							} catch (error) {
								if (error.message === 'invalid token') {
									// see if they provided a refresh token; we can allow that and pass it on to operations API
									try {
										await validateRefreshToken(credentials);
										return applyResponseHeaders({
											// we explicitly declare we don't want to handle this because the operations
											// API has its own logic for handling this
											status: -1,
										});
									} catch (refresh_error) {
										throw error;
									}
								}
							}
							break;
					}
				} catch (err) {
					if (LOG_AUTH_FAILED) {
						const failed_attempt = authorization_cache.get(credentials);
						if (!failed_attempt) {
							authorization_cache.set(credentials, credentials);
							authAuditLog(username, AUTH_AUDIT_STATUS.FAILURE, strategy);
						}
					}

					return applyResponseHeaders({
						status: 401,
						body: serializeMessage({ error: err.message }, request),
					});
				}

				authorization_cache.set(authorization, new_user);
				if (LOG_AUTH_SUCCESSFUL) authAuditLog(new_user.username, AUTH_AUDIT_STATUS.SUCCESS, strategy);
			}

			request.user = new_user;
		} else if (session?.user) {
			// or should this be cached in the session?
			request.user = await server.getUser(session.user, null, request);
		} else if (
			(AUTHORIZE_LOCAL && (request.ip?.includes('127.0.0.') || request.ip == '::1')) ||
			(request?._nodeRequest?.socket?.server?._pipeName && request.ip === undefined) // allow socket domain
		) {
			request.user = await getSuperUser();
		}
		if (ENABLE_SESSIONS) {
			request.session.update = function (updated_session) {
				const expires = env.get(CONFIG_PARAMS.AUTHENTICATION_COOKIE_EXPIRES);
				if (!session_id) {
					session_id = uuid();
					const domains = env.get(CONFIG_PARAMS.AUTHENTICATION_COOKIE_DOMAINS);
					const expires_string = expires
						? new Date(Date.now() + convertToMS(expires)).toUTCString()
						: DEFAULT_COOKIE_EXPIRES;
					const domain = domains?.find((domain) => headers.host?.endsWith(domain));
					const cookie_prefix =
						(origin ? origin.replace(/^https?:\/\//, '').replace(/\W/, '_') + '-' : '') + 'hdb-session=';
					const cookie = `${cookie_prefix}${session_id}; Path=/; Expires=${expires_string}; ${domain ? 'Domain=' + domain + '; ' : ''}HttpOnly${
						request.protocol === 'https' ? '; SameSite=None; Secure' : ''
					}`;
					if (response_headers) {
						response_headers.push('Set-Cookie', cookie);
					} else if (response?.headers?.set) {
						response.headers.set('Set-Cookie', cookie);
					}
				}
				if (request.protocol === 'https') {
					// Indicate that we have successfully updated a session
					// We make sure this is allowed by CORS so that a client can determine if it has
					// a valid cookie-authenticated session (studio needs this)
					if (response_headers) {
						if (origin) response_headers.push('Access-Control-Expose-Headers', 'X-Hdb-Session');
						response_headers.push('X-Hdb-Session', 'Secure');
					} else if (response?.headers?.set) {
						if (origin) response.headers.set('Access-Control-Expose-Headers', 'X-Hdb-Session');
						response.headers.set('X-Hdb-Session', 'Secure');
					}
				}
				updated_session.id = session_id;
				return session_table.put(updated_session, {
					expiresAt: expires ? Date.now() + convertToMS(expires) : undefined,
				});
			};
			request.login = async function (username: string, password: string) {
				const user: any = (request.user = await server.authenticateUser(username, password, request));
				request.session.update({ user: user && (user.getId?.() ?? user.username) });
			};
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
				response.headers.set('Location', resources.loginPath(request));
			} // the HTTP specified way of indicating HTTP authentication methods supported:
			else response.headers.set('WWW-Authenticate', 'Basic');
		}
		return applyResponseHeaders(response);
	} catch (error) {
		throw applyResponseHeaders(error);
	}
	function applyResponseHeaders(response) {
		const l = response_headers.length;
		if (l > 0) {
			let headers = response.headers;
			if (!headers) response.headers = headers = new Headers();
			for (let i = 0; i < l; ) {
				const name = response_headers[i++];
				headers.set(name, response_headers[i++]);
			}
		}
		response_headers = null;
		return response;
	}
}
let started;
export function start({ server, port, securePort }) {
	server.http(authentication, port || securePort ? { port, securePort } : { port: 'all' });
	// keep it cleaned out periodically
	if (!started) {
		started = true;
		setInterval(() => {
			authorization_cache = new Map();
		}, env.get(CONFIG_PARAMS.AUTHENTICATION_CACHETTL)).unref();
		user.addListener(() => {
			authorization_cache = new Map();
		});
	}
}
// operations
export async function login(login_object) {
	if (!login_object.baseRequest?.login) throw new Error('No session for login');
	// intercept any attempts to set headers on the standard response object and pass them on to fastify
	login_object.baseResponse.headers.set = (name, value) => {
		login_object.fastifyResponse.header(name, value);
	};
	await login_object.baseRequest.login(login_object.username, login_object.password ?? '');
	return 'Login successful';
}

export async function logout(logout_object) {
	if (!logout_object.baseRequest.session) throw new Error('No session for logout');
	await logout_object.baseRequest.session.update({ user: null });
	return 'Logout successful';
}
import { serializeMessage } from '../server/serverHelpers/contentTypes';
