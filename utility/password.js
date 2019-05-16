let crypto = require('crypto');
let SaltLength = 9;

function createHash(password) {
    let salt = generateSalt(SaltLength);
    let hash = md5(password + salt);
    return salt + hash;
}

function validateHash(hash, password) {
    let salt = hash.substr(0, SaltLength);
    let validHash = salt + md5(password + salt);
    return hash === validHash;
}

function generateSalt(len) {
    let set = '0123456789abcdefghijklmnopqurstuvwxyzABCDEFGHIJKLMNOPQURSTUVWXYZ',
        setLen = set.length,
        salt = '';
    for (let i = 0; i < len; i++) {
        let p = Math.floor(Math.random() * setLen);
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