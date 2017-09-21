var crypto = require('crypto');
const winston = require('./logging/winston_logger');

var SaltLength = 9;

function createHash(password) {
    var salt = generateSalt(SaltLength);
 winston.error("THE SALT %s", salt);
 winston.error("the PASSWD: %s", password);
    var hash = md5(password + salt);
  winston.error("the HASH: %s", hash);
    return salt + hash;
}

function validateHash(hash, password) {
    var salt = hash.substr(0, SaltLength);
    var validHash = salt + md5(password + salt);
    return hash === validHash;
}

function generateSalt(len) {
    var set = '0123456789abcdefghijklmnopqurstuvwxyzABCDEFGHIJKLMNOPQURSTUVWXYZ',
        setLen = set.length,
        salt = '';
    for (var i = 0; i < len; i++) {
        var p = Math.floor(Math.random() * setLen);
        salt += set[p];
    }
    return salt;
}

function md5(string) {
    return crypto.createHash('md5').update(string).digest('hex');
}

module.exports = {
    'hash': createHash,
    'validate': validateHash
};
