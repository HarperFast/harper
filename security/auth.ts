import { getSuperUser } from './user.js';
import { server } from '../server/Server.ts';
import { resources } from '../resources/Resources.ts';
import { validateOperationToken, validateRefreshToken } from './tokenAuthentication.ts';
import { table } from '../resources/databases.ts';
import { v4 as uuid } from 'uuid';
import * as env from '../utility/environment/environmentManager.js';
import { CONFIG_PARAMS, AUTH_AUDIT_STATUS, AUTH_AUDIT_TYPES } from '../utility/hdbTerms.ts';
import harperLogger from '../utility/logging/harper_logger.js';
const { forComponent, AuthAuditLog } = harperLogger;
import serverHandlers from '../server/itc/serverHandlers.js';
const { user } = serverHandlers;
import { Headers } from '../server/serverHelpers/Headers.ts';
import { convertToMS } from '../utility/common_utils.js';
import { verifyCertificate } from './certificateVerification.ts';
import { serializeMessage } from '../server/serverHelpers/contentTypes.ts';
const authLogger = forComponent('authentication');
const { debug } = authLogger;
const authEventLog = authLogger.withTag('auth-event');
env.initSync();

const appsCorsAccesslist = env.get(CONFIG_PARAMS.HTTP_CORSACCESSLIST);
const appsCors = env.get(CONFIG_PARAMS.HTTP_CORS);
const operationsCorsAccesslist = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORSACCESSLIST);
const operationsCors = env.get(CONFIG_PARAMS.OPERATIONSAPI_NETWORK_CORS);

const sessionTable = table({
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

let authorizationCache = new Map();
server.onInvalidatedUser(() => {
	// TODO: Eventually we probably want to be able to invalidate individual users
	authorizationCache = new Map();
});
export function bypassAuth() {
	AUTHORIZE_LOCAL = true;
}

// TODO: Make this not return a promise if it can be fulfilled synchronously (from cache)
export async function authentication(request, nextHandler) {
	const headers = request.headers.asObject; // we cheat and use the node headers object since it is a little faster
	const authorization = headers.authorization;
	const cookie = headers.cookie;
	let origin = headers.origin;
	let responseHeaders = [];
	try {
		if (origin) {
			const accessList = request.isOperationsServer
				? operationsCors
					? operationsCorsAccesslist
					: []
				: appsCors
					? appsCorsAccesslist
					: [];
			if (accessList.includes(origin) || accessList.includes('*')) {
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
				responseHeaders.push('Access-Control-Allow-Origin', origin);
				if (ENABLE_SESSIONS) responseHeaders.push('Access-Control-Allow-Credentials', 'true');
			}
		}
		let sessionId;
		let session;
		if (ENABLE_SESSIONS) {
			// we prefix the cookie name with the origin so that we can partition/separate session/authentications
			// host, to protect against CSRF
			if (!origin) origin = headers.host;
			const cookiePrefix = (origin ? origin.replace(/^https?:\/\//, '').replace(/\W/, '_') + '-' : '') + 'hdb-session=';
			const cookies = cookie?.split(/;\s+/) || [];
			for (const cookie of cookies) {
				if (cookie.startsWith(cookiePrefix)) {
					const end = cookie.indexOf(';');
					sessionId = cookie.slice(cookiePrefix.length, end === -1 ? cookie.length : end);
					session = await sessionTable.get(sessionId);
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
			if (sessionId) log.session_id = sessionId;
			if (headers['referer']) log.referer = headers['referer'];
			if (headers['origin']) log.origin = headers['origin'];

			if (status === AUTH_AUDIT_STATUS.SUCCESS) authEventLog.info?.(log);
			else authEventLog.error?.(log);
		};

		if (
			!request.authorized &&
			request.mtlsConfig &&
			request.peerCertificate.subject &&
			request?._nodeRequest?.socket?.authorizationError
		)
			authEventLog.error?.('Authorization error:', request._nodeRequest.socket.authorizationError);

		if (request.mtlsConfig && request.authorized && request.peerCertificate.subject) {
			const verificationResult = await verifyCertificate(request.peerCertificate, request.mtlsConfig);
			if (!verificationResult.valid) {
				authEventLog.error?.(
					'Certificate verification failed:',
					verificationResult.status,
					'for',
					request.peerCertificate.subject.CN
				);
				return applyResponseHeaders({
					status: 401,
					body: serializeMessage({ error: 'Certificate revoked or verification failed' }, request),
				});
			}

			// Alternative behavior: Instead of returning 401 above, we could just not set the user
			// and let authentication fall through to other methods (Basic auth, etc.):
			// if (verificationResult.valid) {
			//     // Only extract user from certificate if verification passed
			//     let username = ...
			// }

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

		let newUser;
		if (request.user) {
			// already authenticated
		} else if (authorization) {
			newUser = authorizationCache.get(authorization);
			if (!newUser) {
				const spaceIndex = authorization.indexOf(' ');
				const strategy = authorization.slice(0, spaceIndex);
				const credentials = authorization.slice(spaceIndex + 1);
				let username, password;
				try {
					switch (strategy) {
						case 'Basic':
							const decoded = atob(credentials);
							const colonIndex = decoded.indexOf(':');
							username = decoded.slice(0, colonIndex);
							password = decoded.slice(colonIndex + 1);
							// legacy support for passing in blank username and password to indicate no auth
							newUser = username || password ? await server.getUser(username, password, request) : null;
							break;
						case 'Bearer':
							try {
								newUser = await validateOperationToken(credentials);
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
									} catch (refreshError) {
										throw error;
									}
								}
							}
							break;
					}
				} catch (err) {
					if (LOG_AUTH_FAILED) {
						const failedAttempt = authorizationCache.get(credentials);
						if (!failedAttempt) {
							authorizationCache.set(credentials, credentials);
							authAuditLog(username, AUTH_AUDIT_STATUS.FAILURE, strategy);
						}
					}

					return applyResponseHeaders({
						status: 401,
						body: serializeMessage({ error: err.message }, request),
					});
				}

				authorizationCache.set(authorization, newUser);
				if (LOG_AUTH_SUCCESSFUL) authAuditLog(newUser.username, AUTH_AUDIT_STATUS.SUCCESS, strategy);
			}

			request.user = newUser;
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
			request.session.update = function (updatedSession) {
				const expires = env.get(CONFIG_PARAMS.AUTHENTICATION_COOKIE_EXPIRES);
				const useSecure =
					request.protocol === 'https' ||
					headers.host?.startsWith('localhost:') ||
					headers.host?.startsWith('127.0.0.1:') ||
					headers.host?.startsWith('::1');
				if (!sessionId) {
					sessionId = uuid();
					const domains = env.get(CONFIG_PARAMS.AUTHENTICATION_COOKIE_DOMAINS);
					const expiresString = expires
						? new Date(Date.now() + convertToMS(expires)).toUTCString()
						: DEFAULT_COOKIE_EXPIRES;
					const domain =
						headers.host &&
						domains?.find((domain) => {
							// find a domain that matches the host header
							// the configured cookie domain starts with a dot, that indicates a wildcard, so we need to remove it
							if (domain.startsWith('.')) domain = domain.slice(1);
							// host can have a port, so we need to remove it because we are comparing domain names
							const portStart = headers.host.indexOf(':');
							const host = portStart !== -1 ? headers.host.slice(0, portStart) : headers.host;
							return host.endsWith(domain);
						});
					const cookiePrefix =
						(origin ? origin.replace(/^https?:\/\//, '').replace(/\W/, '_') + '-' : '') + 'hdb-session=';
					// "Secure" can work with localhost/127.0.0.1 in certain browsers.
					// https://github.com/httpwg/http-extensions/issues/2605
					let cookie = `${cookiePrefix}${sessionId}; Path=/; Expires=${expiresString}; HttpOnly`;
					if (domain) {
						cookie += `; Domain=${domain}`;
					}

					if (useSecure) {
						cookie += `; SameSite=None; Secure`;
					}
					if (responseHeaders) {
						responseHeaders.push('Set-Cookie', cookie);
					} else if (response?.headers?.set) {
						response.headers.set('Set-Cookie', cookie);
					}
				}
				if (useSecure) {
					// Indicate that we have successfully updated a session
					// We make sure this is allowed by CORS so that a client can determine if it has
					// a valid cookie-authenticated session (studio needs this)
					if (responseHeaders) {
						if (origin) responseHeaders.push('Access-Control-Expose-Headers', 'X-Hdb-Session');
						responseHeaders.push('X-Hdb-Session', 'Secure');
					} else if (response?.headers?.set) {
						if (origin) response.headers.set('Access-Control-Expose-Headers', 'X-Hdb-Session');
						response.headers.set('X-Hdb-Session', 'Secure');
					}
				}
				updatedSession.id = sessionId;
				return sessionTable.put(updatedSession, {
					expiresAt: expires ? Date.now() + convertToMS(expires) : undefined,
				});
			};
			request.login = async function (username: string, password: string) {
				const user: any = (request.user = await server.authenticateUser(username, password, request));
				request.session.update({ user: user && (user.getId?.() ?? user.username) });
			};
		}
		const response = await nextHandler(request);
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
		const l = responseHeaders.length;
		if (l > 0) {
			let headers = response.headers;
			if (!headers) response.headers = headers = new Headers();
			for (let i = 0; i < l; ) {
				const name = responseHeaders[i++];
				headers.set(name, responseHeaders[i++]);
			}
		}
		responseHeaders = null;
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
			authorizationCache = new Map();
		}, env.get(CONFIG_PARAMS.AUTHENTICATION_CACHETTL)).unref();
		user.addListener(() => {
			authorizationCache = new Map();
		});
	}
}
// operations
export async function login(loginObject) {
	if (!loginObject.baseRequest?.login) throw new Error('No session for login');
	// intercept any attempts to set headers on the standard response object and pass them on to fastify
	loginObject.baseResponse.headers.set = (name, value) => {
		loginObject.fastifyResponse.header(name, value);
	};
	await loginObject.baseRequest.login(loginObject.username, loginObject.password ?? '');
	return 'Login successful';
}

export async function logout(logoutObject) {
	if (!logoutObject.baseRequest.session) throw new Error('No session for logout');
	await logoutObject.baseRequest.session.update({ user: null });
	return 'Logout successful';
}
