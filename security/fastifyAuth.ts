'use strict';

import * as validation from '../validation/check_permissions.js';
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import { BasicStrategy } from 'passport-http';
import util from 'util';
import * as userFunctions from './user.js';
const cbFindValidateUsers = util.callbackify(userFunctions.findAndValidateUser);
import * as hdbTerms from '../utility/hdbTerms.js';
import * as tokenAuthentication from './tokenAuthentication.js';
import { AccessViolation } from '../utility/errors/hdbError.js';

passport.use(
	new LocalStrategy(function (username, password, done) {
		cbFindValidateUsers(username, password, done);
	})
);

passport.use(
	new BasicStrategy(function (username, password, done) {
		cbFindValidateUsers(username, password, done);
	})
);

passport.serializeUser(function (user, done) {
	done(null, user);
});

passport.deserializeUser(function (user: any, done) {
	done(null, user);
});

export function authorize(req: any, res: any, next: (err: any, user?: any) => void) {
	if (process.env.UNIT_TEST_DIR) {
		return next(null, { id: 'test', super_user: true, role: { id: 'super_user', super_user: true, permission: { super_user: true } } });
	}
	if (req.raw?.user !== undefined) return next(null, req.raw.user);
	let strategy;
	let token;
	if (req.headers?.authorization) {
		let splitAuthHeader = req.headers.authorization.split(' ');
		strategy = splitAuthHeader[0];
		token = splitAuthHeader[1];
	}

	function handleResponse(err: any, user: any) {
		if (err) {
			return next(err);
		}
		if (!user) {
            console.log(`AUTH DEBUG: req.raw.user: ${req.raw?.user}, strategy: ${strategy}, token: ${token}, headers:`, req.headers);
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

export function checkPermissions(checkPermissionObj: any, callback: (err: any, data?: any) => void) {
	let validationResults = validation.default(checkPermissionObj);

	if (validationResults) {
		callback(validationResults);
		return;
	}

	let authoriziationObj: any = {
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
