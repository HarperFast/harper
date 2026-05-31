'use strict';

import * as validation from '../validation/check_permissions.ts';
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import { BasicStrategy } from 'passport-http';
import * as util from 'util';
import * as userFunctions from './user.ts';
const cbFindValidateUsers = util.callbackify(userFunctions.findAndValidateUser);
import * as hdbTerms from '../utility/hdbTerms.ts';
import * as tokenAuthentication from './tokenAuthentication.ts';
import { AccessViolation } from '../utility/errors/hdbError.ts';
import { authentication } from './auth.ts';

passport.use(
	new LocalStrategy(function (username, password, done) {
		(cbFindValidateUsers as any)(username, password, done);
	})
);

passport.use(
	new BasicStrategy(function (username, password, done) {
		(cbFindValidateUsers as any)(username, password, done);
	})
);

passport.serializeUser(function (user, done) {
	done(null, user);
});

passport.deserializeUser(function (user, done) {
	done(null, user);
});

const INTERNAL_USER_HEADER = 'x-harper-internal-pre-auth-user';

export function authorize(req: any, res: any, next: any) {
	if (req.raw?.user != undefined) {
		return next(null, req.raw.user);
	}
	// On Bun, Harper's auth middleware passes pre-authenticated users via this internal header.
	// bunDelegateToNodeServer strips it from real network requests before injecting into Fastify,
	// so it is only safe to trust under Bun — on Node.js the raw socket path delivers headers
	// directly to Fastify with no stripping, so a forged header could bypass auth.
	if (typeof globalThis.Bun !== 'undefined') {
		const preAuthUser = req.headers?.[INTERNAL_USER_HEADER];
		if (preAuthUser) return next(null, JSON.parse(preAuthUser));
		// No pre-auth header: auth.ts didn't run for this port (ops API). Mirror what Node.js does via
		// baseRequest — build a shim request and call authentication() so AUTHORIZE_LOCAL can apply.
		const shimRequest = {
			headers: { asObject: Object.assign({}, req.headers) },
			ip: req.socket?.remoteAddress ?? '',
			isOperationsServer: true,
			method: req.method,
			url: req.url,
			pathname: (req.url ?? '/').split('?')[0],
			authorized: undefined,
			mtlsConfig: undefined,
			peerCertificate: { subject: null },
			_nodeRequest: null,
			_nodeResponse: null,
		};
		let nextCalled = false;
		return authentication(shimRequest, (request) => {
			nextCalled = true;
			if (request.user) return next(null, request.user);
			req.raw.user = null;
			return authorize(req, res, next);
		}).then(
			(response) => {
				if (nextCalled) return response;
				if (response?.status === -1) {
					req.raw.user = null;
					return authorize(req, res, next);
				}
				const body = typeof response?.body === 'string' ? JSON.parse(response.body) : (response?.body ?? {});
				return next(new Error(body.error ?? body));
			},
			(error) => next(error)
		);
	}
	if (req.raw?.user === undefined && req.raw?.baseRequest) {
		let nextCalled = false;
		return authentication(req.raw?.baseRequest, (request: any) => {
			nextCalled = true;
			if (request.user) {
				req.raw.user = request.user;
				return next(null, req.raw.user);
			} else {
				req.raw.user = null; // don't fall in this branch again
				return authorize(req, res, next);
			}
		}).then(
			(response: any) => {
				if (nextCalled) {
					return response;
				}
				if (response?.status === -1) {
					// authentication declined (e.g. refresh token) — fall through to the
					// Bearer/Basic handling below
					req.raw.user = null;
					return authorize(req, res, next);
				}
				const body = JSON.parse(response.body);
				return next(new Error(body.error ?? body));
			},
			(error: any) => {
				return next(error);
			}
		);
	}
	let strategy;
	let token;
	if (req.headers?.authorization) {
		let splitAuthHeader = req.headers.authorization.split(' ');
		strategy = splitAuthHeader[0];
		token = splitAuthHeader[1];
	}

	function handleResponse(err, user) {
		if (err) {
			return next(err);
		}
		if (!user) {
			return next(new AccessViolation());
		}
		return next(null, user);
	}

	switch (strategy) {
		case 'Basic':
			passport.authenticate('basic', { session: false }, (err, user) => {
				handleResponse(err, user);
			})(req, res, next);
			break;
		case 'Bearer':
			if (req.body?.operation && req.body.operation === hdbTerms.OPERATIONS_ENUM.REFRESH_OPERATION_TOKEN) {
				tokenAuthentication
					.validateRefreshToken(token)
					.then((user) => {
						req.body.refresh_token = token;
						next(null, user);
					})
					.catch((e) => {
						next(e);
					});
			} else {
				tokenAuthentication
					.validateOperationToken(token)
					.then((user) => {
						next(null, user);
					})
					.catch((e) => {
						next(e);
					});
			}
			break;
		default:
			passport.authenticate('local', { session: false }, function (err, user) {
				handleResponse(err, user);
			})(req, res, next);
			break;
	}
}

export function checkPermissions(checkPermissionObj: any, callback: any) {
	let validationResults = (validation as any).default
		? (validation as any).default(checkPermissionObj)
		: (validation as any)(checkPermissionObj);

	if (validationResults) {
		callback(validationResults);
		return;
	}

	let authoriziationObj = {
		authorized: true,
		messages: [],
	};

	let role = checkPermissionObj.user.role;

	if (!role?.permission) {
		return callback('Invalid role');
	}
	let permission = JSON.parse(role.permission);

	if (permission.super_user) {
		return callback(null, authoriziationObj);
	}

	if (!permission[checkPermissionObj.schema]) {
		authoriziationObj.authorized = false;
		authoriziationObj.messages.push(`Not authorized to access ${checkPermissionObj.schema} schema`);
		return callback(null, authoriziationObj);
	}

	if (!permission[checkPermissionObj.schema].tables[checkPermissionObj.table]) {
		authoriziationObj.authorized = false;
		authoriziationObj.messages.push(`Not authorized to access ${checkPermissionObj.table} table`);
		return callback(null, authoriziationObj);
	}

	if (!permission[checkPermissionObj.schema].tables[checkPermissionObj.table][checkPermissionObj.operation]) {
		authoriziationObj.authorized = false;
		authoriziationObj.messages.push(
			`Not authorized to access ${checkPermissionObj.operation} on ${checkPermissionObj.table} table`
		);
		return callback(null, authoriziationObj);
	}

	if (
		permission[checkPermissionObj.schema].tables[checkPermissionObj.table].attribute_permissions &&
		!checkPermissionObj.attributes
	) {
		authoriziationObj.authorized = false;
		authoriziationObj.messages.push(
			`${checkPermissionObj.schema}.${checkPermissionObj.table} has attribute permissions. Missing attributes to validate`
		);
		return callback(null, authoriziationObj);
	}

	if (
		permission[checkPermissionObj.schema].tables[checkPermissionObj.table].attribute_permissions &&
		checkPermissionObj.attributes
	) {
		let restrictedAttrs = permission[checkPermissionObj.schema].tables[checkPermissionObj.table].attribute_permissions;
		for (let rAttr in restrictedAttrs) {
			if (
				checkPermissionObj.attributes.indexOf(restrictedAttrs[rAttr].attribute_name) > -1 &&
				!restrictedAttrs[rAttr][checkPermissionObj.operation]
			) {
				authoriziationObj.authorized = false;
				authoriziationObj.messages.push(
					`Not authorized to ${checkPermissionObj.operation} ${restrictedAttrs[rAttr].attribute_name} `
				);
			}
		}
	}

	return callback(null, authoriziationObj);
}
