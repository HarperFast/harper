'use strict';

const crypto = require('crypto');
const CRYPTO_ALGORITHM = 'aes-256-cbc';
const KEY_BYTE_LENGTH = 32;
const IV_BYTE_LENGTH = 16;
const KEY_STRING_LENGTH = 64;
const IV_STRING_LENGTH = 32;
const ENCRYPTED_STRING_START = KEY_STRING_LENGTH + IV_STRING_LENGTH;

// This is where we cache all the schema.table hashes that get used as nats stream names for local tables.
const hash_cache = new Map();

module.exports = {
	encrypt: encrypt,
	decrypt: decrypt,
	createNatsTableStreamName,
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
	let decipher = crypto.createDecipheriv(CRYPTO_ALGORITHM, Buffer.from(key_string, 'hex'), iv);
	let decrypted = decipher.update(encryptedText);
	decrypted = Buffer.concat([decrypted, decipher.final()]);
	return decrypted.toString();
}

/**
 * Hashes the schema and table names to create a unique alphanumeric hash that will always
 * be the same length and the same value. Caches hash if not already cached.
 * Note - this function is in this file to avoid circular dependencies.
 * @param schema
 * @param table
 * @returns {string}
 */
function createNatsTableStreamName(schema, table) {
	if (!table) return schema;
	const full_name = `${schema}.${table}`;
	let hash = hash_cache.get(full_name);
	if (!hash) {
		hash = crypto.createHash('md5').update(`${schema}.${table}`).digest('hex');
		hash_cache.set(full_name, hash);
	}

	return hash;
}
