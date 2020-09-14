'use strict';

const jwt = require('jsonwebtoken');
const {promisify} = require('util');
const auth = require('./auth');
const p_find_validate_user = promisify(auth.findAndValidateUser);

async function createAuthToken(auth_object){
    //validate auth_object

    //query for user/pw
    let user = await p_find_validate_user(auth_object.username, auth_object.password);
    if(!user){
        //throw error
    }

    //get rsa key

    //sign tokens

    //return json
}