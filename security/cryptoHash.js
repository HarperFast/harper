'use strict';

const crypto = require('crypto');
const envMgr = require('../utility/environment/environmentManager.js');
const { CONFIG_PARAMS } = require('../utility/hdbTerms.ts');

const CRYPTO_ALGORITHM = 'aes-256-cbc';
const KEY_BYTE_LENGTH = 32;
const IV_BYTE_LENGTH = 16;
const KEY_STRING_LENGTH = 64;
const IV_STRING_LENGTH = 32;
const ENCRYPTED_STRING_START = KEY_STRING_LENGTH + IV_STRING_LENGTH;

// This is where we cache all the schema.table hashes that get used as nats stream names for local tables.
const hashCache = new Map();

module.exports = {
	encrypt,
	decrypt,
	createNatsTableStreamName,
};

function encrypt(text) {
	let key = crypto.randomBytes(KEY_BYTE_LENGTH);
	let iv = crypto.randomBytes(IV_BYTE_LENGTH);

	let cipher = crypto.createCipheriv(CRYPTO_ALGORITHM, Buffer.from(key), iv);
	let encrypted = cipher.update(text);
	encrypted = Buffer.concat([encrypted, cipher.final()]);

	let keyString = key.toString('hex');
	let ivString = iv.toString('hex');
	let encryptedString = encrypted.toString('hex');
	return keyString + ivString + encryptedString;
}

function decrypt(text) {
	let keyString = text.substr(0, KEY_STRING_LENGTH);
	let ivString = text.substr(KEY_STRING_LENGTH, IV_STRING_LENGTH);
	let encrptedString = text.substr(ENCRYPTED_STRING_START, text.length);

	let iv = Buffer.from(ivString, 'hex');
	let encryptedText = Buffer.from(encrptedString, 'hex');
	let decipher = crypto.createDecipheriv(CRYPTO_ALGORITHM, Buffer.from(keyString, 'hex'), iv);
	let decrypted = decipher.update(encryptedText);
	decrypted = Buffer.concat([decrypted, decipher.final()]);
	return decrypted.toString();
}

/**
 * Hashes the schema and table names to create a unique alphanumeric hash that will always
 * be the same length and the same value. Caches hash if not already cached.
 * Note - this function is in this file to avoid circular dependencies.
 * @param database
 * @param table
 * @returns {string}
 */
function createNatsTableStreamName(database, table) {
	// TODO: Real config here
	const fullName = envMgr.get(CONFIG_PARAMS.CLUSTERING_DATABASELEVEL) ? database : `${database}.${table}`;
	let hash = hashCache.get(fullName);
	if (!hash) {
		hash = crypto.createHash('md5').update(fullName).digest('hex');
		hashCache.set(fullName, hash);
	}

	return hash;
}
