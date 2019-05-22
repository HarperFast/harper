"use strict";

const crypto = require('crypto');
const CRYPTO_ALGORITHM = 'aes-256-cbc';
const KEY_BYTE_LENGTH = 32;
const IV_BYTE_LENGTH = 16;
const KEY_STRING_LENGTH = 64;
const IV_STRING_LENGTH = 32;
const ENCRYPTED_STRING_START = KEY_STRING_LENGTH + IV_STRING_LENGTH;

module.exports = {
    encrypt: encrypt,
    decrypt: decrypt
};

function encrypt(text) {
    let key = crypto.randomBytes(KEY_BYTE_LENGTH);
    let iv = crypto.randomBytes(IV_BYTE_LENGTH);

    let cipher = crypto.createCipheriv(CRYPTO_ALGORITHM, Buffer.from(key), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    let key_string = key.toString('hex');
    let iv_string = iv.toString('hex');
    let encrypted_string = encrypted.toString('hex');
    return key_string + iv_string + encrypted_string;
}

function decrypt(text) {
    let key_string = text.substr(0, KEY_STRING_LENGTH);
    let iv_string = text.substr(KEY_STRING_LENGTH, IV_STRING_LENGTH);
    let encrpted_string = text.substr(ENCRYPTED_STRING_START, text.length);

    let iv = Buffer.from(iv_string, 'hex');
    let encryptedText = Buffer.from(encrpted_string, 'hex');
    let decipher = crypto.createDecipheriv(CRYPTO_ALGORITHM, Buffer.from(key_string, "hex"), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}