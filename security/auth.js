const express = require('express');
router = express.Router(),
    search = require('../data_layer/search'),
    password_function = require('../utility/password');
var passport = require('passport')
    , LocalStrategy = require('passport-local').Strategy,
    BasicStrategy = require('passport-http').BasicStrategy;


function findAndValidateUser(username, password, done){
    var search_obj = {};
    search_obj.schema = 'system';
    search_obj.table = 'hdb_user';
    search_obj.hash_attribute = 'username';
    search_obj.hash_value = username;
    search_obj.get_attributes = ['username', 'password', 'role'];
    search.searchByHash(search_obj, function (err, user_data) {
        if (err) {
            return done(err);
        }

        if (!user_data) {
            return done('User not found', null);
        }

        if (!password_function.validate(user_data.password, password)) {
            return done('Invalid password', false);
        }

        return done(null, user_data);


    });
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

function checkPermissions(user, table, attribute, operation) {

}


module.exports = {
    authorize: authorize
}