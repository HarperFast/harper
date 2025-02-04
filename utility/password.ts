import * as crypto from 'node:crypto';
import * as argon2 from 'argon2';
import { get } from './environment/environmentManager';
import { CONFIG_PARAMS } from './hdbTerms';
const configuredHashFunction = get(CONFIG_PARAMS.AUTHENTICATION_HASHFUNCTION)?.toLowerCase();

const SALT_LENGTH = 16;
const SALT_LENGTH_MD5 = 9;
export enum HASH_FUNCTION {
	MD5 = 'md5',
	SHA256 = 'sha256',
	ARGON2ID = 'argon2id',
}

type HashFunction = (typeof HASH_FUNCTION)[keyof typeof HASH_FUNCTION];

/**
 * Generate a secure salt
 * @param len Length of salt (defaults to SALT_LENGTH)
 */
function generateSalt(len: number = SALT_LENGTH): string {
	const set = '0123456789abcdefghijklmnopqurstuvwxyzABCDEFGHIJKLMNOPQURSTUVWXYZ';
	return Array.from(crypto.randomBytes(len))
		.map((x) => set[x % set.length])
		.join('');
}

const hashAlgorithms = {
	[HASH_FUNCTION.MD5]: (password: string, salt = undefined) => {
		salt = salt ?? generateSalt(SALT_LENGTH_MD5);
		const hashed = crypto
			.createHash(HASH_FUNCTION.MD5)
			.update(password + salt)
			.digest('hex');
		return salt + hashed;
	},

	[HASH_FUNCTION.SHA256]: (password: string, salt = undefined) => {
		salt = salt ?? generateSalt(SALT_LENGTH);
		const hashed = crypto
			.createHash(HASH_FUNCTION.SHA256)
			.update(password + salt)
			.digest('hex');
		return salt + hashed;
	},

	[HASH_FUNCTION.ARGON2ID]: async (password: string) => {
		const salt = generateSalt(SALT_LENGTH);
		const hashed = await argon2.hash(password, {
			type: argon2.argon2id,
			salt: Buffer.from(salt),
		});
		return salt + hashed;
	},
};

const validateAlgorithms = {
	[HASH_FUNCTION.MD5]: (storedHash: string, password: string) => {
		const salt = storedHash.slice(0, SALT_LENGTH_MD5);
		return storedHash === hashAlgorithms[HASH_FUNCTION.MD5](password, salt);
	},

	[HASH_FUNCTION.SHA256]: (storedHash: string, password: string) => {
		const salt = storedHash.slice(0, SALT_LENGTH);
		return storedHash === hashAlgorithms[HASH_FUNCTION.SHA256](password, salt);
	},

	[HASH_FUNCTION.ARGON2ID]: async (storedHash: string, password: string) => {
		return await argon2.verify(storedHash.slice(SALT_LENGTH), password);
	},
};

/**
 * Create a hash for the given password (MD5, SHA-256 or argon2id)
 * @param password Plain text password
 * @param algorithm Hashing algorithm to use (default: SHA-256)
 */
export function hash(
	password: string | Promise<string>,
	algorithm: HashFunction = HASH_FUNCTION[configuredHashFunction?.toUpperCase()] ?? HASH_FUNCTION.SHA256
): string | Promise<string> {
	return hashAlgorithms[algorithm](password);
}

/**
 * Validate a password against a stored hash
 * @param storedHash Previously generated hash
 * @param password Plain text password to validate
 * @param algorithm Hashing algorithm to use (default: SHA-256)
 */
export function validate(
	storedHash: string | Promise<string>,
	password: string,
	algorithm: HashFunction = HASH_FUNCTION[configuredHashFunction?.toUpperCase()] ?? HASH_FUNCTION.SHA256
): boolean | Promise<boolean> {
	if (!storedHash) return false;

	return validateAlgorithms[algorithm](storedHash, password);
}
