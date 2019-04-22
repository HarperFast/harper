'use strict';

const express = require('express');
const router = express.Router();
const password_function = require('../utility/password');
const validation = require('../validation/check_permissions');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const BasicStrategy = require('passport-http').BasicStrategy;
const util = require('util');
const user_functions = require('./user');
const cb_users_set_global = util.callbackify(user_functions.setUsersToGlobal);
const clone = require('clone');
const systemSchema = require('../json/systemSchema');
const terms = require('../utility/hdbTerms');
const log = require('../utility/logging/harper_logger');

/**
 * adds system table permissions to the logged in user.  This is used to protect system tables by leveraging operationAuthoriation.
 * @param user_role - Role of the user found during auth.
 */
function appendSystemTablesToRole(user_role) {
    try {
        if(!user_role) {
            log.error(`invalid user role found.`);
            return;
        }
        if (!user_role.permission["system"]) {
            user_role.permission["system"] = {};
        }
        if (!user_role.permission.system["tables"]) {
            user_role.permission.system["tables"] = {};
        }
        for (let table of Object.keys(systemSchema)) {
            let new_prop = {};
            new_prop["read"] = (!!user_role.permission.super_user);
            new_prop["insert"] = false;
            new_prop["update"] = false;
            new_prop["delete"] = false;
            new_prop["attribute_restrictions"] = [];
            user_role.permission.system.tables[table] = new_prop;
        }
    } catch(err) {
        log.error(`Got an error trying to set system permissions.`);
        log.error(err);
    }
}

function findAndValidateUser(username, password, done) {
    if (!global.hdb_users) {
        cb_users_set_global(() => {
            handleResponse();
        });
    } else {
        handleResponse();
    }

    function handleResponse() {
        let user_tmp = global.hdb_users.filter((user) => {
            return user.username === username;
        })[0];

        if (!user_tmp) {
            return done(`Cannot complete request: User '${username}' not found`, null);
        }

        if (user_tmp && !user_tmp.active) {
            return done('Cannot complete request: User is inactive', null);
        }
        let user = clone(user_tmp);
        if (!password_function.validate(user.password, password)) {
            return done('Cannot complete request:  Invalid password', false);
        }
        delete user.password;
        appendSystemTablesToRole(user.role);
        return done(null, user);
    }

}


passport.use(new LocalStrategy(
    function (username, password, done) {
        findAndValidateUser(username, password, done);

    }
));

passport.use(new BasicStrategy(
    function (username, password, done) {
        findAndValidateUser(username, password, done);
    }));


passport.serializeUser(function (user, done) {
    done(null, user);
});

passport.deserializeUser(function (user, done) {
    done(null, user);
});


router.post('/',
    passport.authenticate('basic', {session: false}),
    function (req, res) {
        // If this function gets called, authentication was successful.
        // `req.user` contains the authenticated user.
        res.status(terms.HTTP_STATUS_CODES.OK).send(req.user.username);
    });

function authorize(req, res, next) {
    let found_user = null;
    let strategy;
    if (req.headers && req.headers.authorization) {
        strategy = req.headers.authorization.split(' ')[0];
    }

    function handleResponse(err, user, info) {
        if (err) {
            return next(err);
        }
        if (!user) {
            return next("User not found");
        }
        if (req.logIn) {
            req.logIn(user, function (err) {
                if (err) {
                    return next(err);
                }
                found_user = user;
                return next(null, user);
            });
        } else {
            found_user = user;
            return next(null, user);
        }
    }

    switch (strategy) {
        case 'Basic':
            passport.authenticate('basic', function (err, user, info) {
                handleResponse(err, user, info);
            })(req, res, next);
            break;
        default:
            passport.authenticate('local', function (err, user, info) {
                handleResponse(err, user, info);
            })(req, res, next);
            break;

    }
    return found_user;

}

function checkPermissions(check_permission_obj, callback) {

    let validation_results = validation(check_permission_obj);

    if (validation_results) {
        callback(validation_results);
        return;
    }

    let authoriziation_obj = {
        authorized: true,
        messages: []
    };

    let role = check_permission_obj.user.role;

    if (!role || !role.permission) {
        return callback('Invalid role');
    }
    let permission = JSON.parse(role.permission);

    if (permission.super_user) {
        return callback(null, authoriziation_obj);
    }

    if (!permission[check_permission_obj.schema]) {
        authoriziation_obj.authorized = false;
        authoriziation_obj.messages.push(`Not authorized to access ${check_permission_obj.schema} schema`);
        return callback(null, authoriziation_obj);
    }

    if (!permission[check_permission_obj.schema].tables[check_permission_obj.table]) {
        authoriziation_obj.authorized = false;
        authoriziation_obj.messages.push(`Not authorized to access ${check_permission_obj.table} table`);
        return callback(null, authoriziation_obj);

    }

    if (!permission[check_permission_obj.schema].tables[check_permission_obj.table][check_permission_obj.operation]) {
        authoriziation_obj.authorized = false;
        authoriziation_obj.messages.push(`Not authorized to access ${check_permission_obj.operation} on ${check_permission_obj.table} table`);
        return callback(null, authoriziation_obj);
    }


    if (permission[check_permission_obj.schema].tables[check_permission_obj.table].attribute_restrictions
        && !check_permission_obj.attributes) {

        authoriziation_obj.authorized = false;
        authoriziation_obj.messages.push(`${check_permission_obj.schema}.${check_permission_obj.table} has attribute restrictions. Missing attributes to validate`);
        return callback(null, authoriziation_obj);
    }

    if (permission[check_permission_obj.schema].tables[check_permission_obj.table].attribute_restrictions
        && check_permission_obj.attributes) {

        let restricted_attrs = permission[check_permission_obj.schema].tables[check_permission_obj.table].attribute_restrictions;
        for (let r_attr in restricted_attrs) {
            if (check_permission_obj.attributes.indexOf(restricted_attrs[r_attr].attribute_name) > -1 && !restricted_attrs[r_attr][check_permission_obj.operation]) {
                authoriziation_obj.authorized = false;
                authoriziation_obj.messages.push(`Not authorized to ${check_permission_obj.operation} ${restricted_attrs[r_attr].attribute_name} `);
            }
        }

    }

    return callback(null, authoriziation_obj);
}


module.exports = {
    authorize: authorize,
    checkPermissions: checkPermissions
};