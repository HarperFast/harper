import * as env from '../../utility/environment/environmentManager.ts';
import fs from 'fs-extra';
import path from 'path';
import * as terms from '../../utility/hdbTerms.ts';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';

export default checkJWTTokenExist;

// Preserve the CJS-callable shape consumers/tests expect — under tsc CJS emit
// this replaces the `exports` object with the function itself, so
// `require('./checkJWTTokenExist')(...)` works. No-op under typestrip ESM.
declare const module: any;
if (typeof module !== 'undefined') {
	module.exports = checkJWTTokenExist;
	module.exports.default = checkJWTTokenExist;
}
/**
 * checks that the RSA keys exist for JWT generation, if not we create them
 */
function checkJWTTokenExist() {
	if (env.getHdbBasePath() !== undefined) {
		//check that key files exist
		let privateKeyPath = path.join(
			env.getHdbBasePath(),
			terms.LICENSE_KEY_DIR_NAME,
			terms.JWT_ENUM.JWT_PRIVATE_KEY_NAME
		);
		let publicKeyPath = path.join(env.getHdbBasePath(), terms.LICENSE_KEY_DIR_NAME, terms.JWT_ENUM.JWT_PUBLIC_KEY_NAME);
		let passphrasePath = path.join(
			env.getHdbBasePath(),
			terms.LICENSE_KEY_DIR_NAME,
			terms.JWT_ENUM.JWT_PASSPHRASE_NAME
		);
		try {
			fs.accessSync(passphrasePath);
			fs.accessSync(privateKeyPath);
			fs.accessSync(publicKeyPath);
		} catch (e) {
			//if any of the files does not exist we need regenerate all
			if (e.code === 'ENOENT') {
				//create unique passphrase
				let passPhrase = uuid();

				//based on https://nodejs.org/docs/latest-v12.x/api/crypto.html#cryptoCryptoGeneratekeypairsyncTypeOptions
				let keyPair = crypto.generateKeyPairSync('rsa', {
					modulusLength: 4096,
					publicKeyEncoding: {
						type: 'spki',
						format: 'pem',
					},
					privateKeyEncoding: {
						type: 'pkcs8',
						format: 'pem',
						cipher: 'aes-256-cbc',
						passphrase: passPhrase,
					},
				});

				fs.writeFileSync(passphrasePath, passPhrase);
				fs.writeFileSync(privateKeyPath, keyPair.privateKey);
				fs.writeFileSync(publicKeyPath, keyPair.publicKey);
			} else {
				throw e;
			}
		}
	}
}
