'use strict';

const express = require('express'),
    router = express.Router(),
    search = require('../data_layer/search'),
    password_function = require('../utility/password'),
    validation = require('../validation/check_permissions'),
    passport = require('passport'),
    LocalStrategy = require('passport-local').Strategy,
    BasicStrategy = require('passport-http').BasicStrategy;


function findAndValidateUser(username, password, done){
    let user = global.hdb_users.filter((user)=>{
        return user.username === username;
    })[0];

    if(!user){
        return done(`Cannot complete request: User '${username}' not found`, null);
    }

    if(user && !user.active){
        return done('Cannot complete request: User is inactive', null);
    }

    if (!password_function.validate(user.password, password)) {
        return done('Cannot complete request:  Invalid password', false);
    }
    delete user.password;
    return done(null, user);
}




passport.use(new LocalStrategy(
    function (username, password, done) {
        findAndValidateUser(username,password,done);

    }
));

passport.use(new BasicStrategy(
    function (username, password, done) {
        findAndValidateUser(username,password,done);
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
        res.status(200).send(req.user.username);
    });

function authorize(req, res, next) {

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
        req.logIn(user, function (err) {
            if (err) {
                return next(err);
            }
            return next(null, user);
        });
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


}

function checkPermissions(check_permission_obj, callback) {

    let validation_results = validation(check_permission_obj);

    if(validation_results){
        callback(validation_results);
        return;
    }

    if (err) {
        return callback(err);
    }


    let authoriziation_obj = {
        authorized: true,
        messages: []
    }

    let role = check_permission_obj.user.role;

    if(!role || !role.permission){
        return callback('Invalid role');
    }
    let permission = JSON.parse(role.permission);

    if(permission.super_user){
        return callback(null, authoriziation_obj);
    }

    if(!permission[check_permission_obj.schema]){
        authoriziation_obj.authorized = false;
        authoriziation_obj.messages.push(`Not authorized to access ${check_permission_obj.schema} schema`);
        return callback(null, authoriziation_obj);
    }

    if(!permission[check_permission_obj.schema].tables[check_permission_obj.table]){
        authoriziation_obj.authorized = false;
        authoriziation_obj.messages.push(`Not authorized to access ${check_permission_obj.table} table`);
        return callback(null, authoriziation_obj);

    }

    if(!permission[check_permission_obj.schema].tables[check_permission_obj.table][check_permission_obj.operation]){
        authoriziation_obj.authorized = false;
        authoriziation_obj.messages.push(`Not authorized to access ${check_permission_obj.operation} on ${check_permission_obj.table} table`);
        return callback(null, authoriziation_obj);
    }


    if(permission[check_permission_obj.schema].tables[check_permission_obj.table].attribute_restrictions
        && !check_permission_obj.attributes ){

        authoriziation_obj.authorized = false;
        authoriziation_obj.messages.push(`${check_permission_obj.schema}.${check_permission_obj.table} has attribute restrictions. Missing attributes to validate`);
        return callback(null, authoriziation_obj);
    }

    if(permission[check_permission_obj.schema].tables[check_permission_obj.table].attribute_restrictions
        && check_permission_obj.attributes ){

        let restricted_attrs = permission[check_permission_obj.schema].tables[check_permission_obj.table].attribute_restrictions;
        for(let r_attr in restricted_attrs){
            if(check_permission_obj.attributes.indexOf(restricted_attrs[r_attr].attribute_name) > -1 && !restricted_attrs[r_attr][check_permission_obj.operation]){
                authoriziation_obj.authorized = false;
                authoriziation_obj.messages.push(`Not authorized to ${check_permission_obj.operation} ${restricted_attrs[r_attr].attribute_name} `);
            }
        }

    }

    callback(null, authoriziation_obj);
    return;
}


module.exports = {
    authorize: authorize,
    checkPermissions: checkPermissions
}