'use strict';

const express = require('express');
const router = express.Router();
const validation = require('../validation/check_permissions');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const BasicStrategy = require('passport-http').BasicStrategy;
const util = require('util');
const user_functions = require('./user');
const cb_find_validate_users = util.callbackify(user_functions.findAndValidateUser);
const hdb_errors = require('../utility/errors/commonErrors');
const token_authentication = require('./tokenAuthentication');

passport.use(new LocalStrategy(
    function (username, password, done) {
        cb_find_validate_users(username, password, done);
    }
));

passport.use(new BasicStrategy(
    function (username, password, done) {
        cb_find_validate_users(username, password, done);
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
        res.status(hdb_errors.HTTP_STATUS_CODES.OK).send(req.user.username);
    });

function authorize(req, res, next) {
    let found_user = null;
    let strategy;
    let token;
    if (req.headers && req.headers.authorization) {
        let split_auth_header = req.headers.authorization.split(' ');
        strategy = split_auth_header[0];
        token = split_auth_header[1];
    }

    function handleResponse(err, user, info) {
        if (err) {
            return next(err);
        }
        if (!user) {
            return next("User not found");
        }
        if (req.logIn) {
            req.logIn(user, function (err_login) {
                if (err_login) {
                    return next(err_login);
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
        case 'Bearer':
            token_authentication.validateOperationToken(token).then((user)=>{
                next(null, user);
            }).catch(e=>{
                next(e);
            });
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


    if (permission[check_permission_obj.schema].tables[check_permission_obj.table].attribute_permissions
        && !check_permission_obj.attributes) {

        authoriziation_obj.authorized = false;
        authoriziation_obj.messages.push(`${check_permission_obj.schema}.${check_permission_obj.table} has attribute permissions. Missing attributes to validate`);
        return callback(null, authoriziation_obj);
    }

    if (permission[check_permission_obj.schema].tables[check_permission_obj.table].attribute_permissions
        && check_permission_obj.attributes) {

        let restricted_attrs = permission[check_permission_obj.schema].tables[check_permission_obj.table].attribute_permissions;
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
