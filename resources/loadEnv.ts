import { parse } from 'dotenv';
import logger from '../utility/logging/harper_logger.ts';
import { Scope } from '../components/Scope.ts';
import { isEncryptedEnvValue } from '../utility/envFile.ts';
import { getSecretDecryptor } from './secretDecryptor.ts';

export function handleApplication(scope: Scope) {
	const override = (scope.options.getAll() as { override?: boolean }).override ?? false;
	scope.handleEntry((entry) => {
		if (entry.eventType !== 'add') {
			scope.requestRestart();
			return;
		}
		logger.debug(`Loading env file: ${entry.absolutePath}`);
		for (const [key, rawValue] of Object.entries(parse(entry.contents))) {
			let value = rawValue;
			// Encrypted (`enc:v1:`) values are decrypted via the Pro env-secrets component if it has
			// registered a decryptor; otherwise the secret stays opaque and is skipped (so the app
			// fails loudly on a missing var rather than receiving ciphertext as the value).
			if (isEncryptedEnvValue(rawValue)) {
				const decryptor = getSecretDecryptor();
				// Logged at error level (not warn) so an undecryptable secret is never silent — but
				// skipped rather than fatal, so the node still boots and the bad value can be fixed via
				// set_env_value, and a non-Pro node isn't crashed by a replicated encrypted value. The
				// app sees a missing var (and should fail on it) rather than receiving ciphertext.
				if (!decryptor) {
					logger.error(
						`Environment variable ${key} from ${entry.absolutePath} is encrypted but no env-secret decryptor is registered (the Harper Pro env-secrets component is required); skipping`
					);
					continue;
				}
				try {
					value = decryptor(rawValue);
				} catch (error) {
					logger.error(
						`Failed to decrypt environment variable ${key} from ${entry.absolutePath}: ${(error as Error).message}; skipping`
					);
					continue;
				}
			}

			if (process.env[key] !== undefined) {
				// an identical value is not a conflict — e.g. a config-shaping var this file already
				// delivered via the pre-config env pass (#1513)
				if (process.env[key] === value) continue;
				logger.warn(`Environment variable conflict: ${key} from ${entry.absolutePath} is already set on process.env`);
				if (override) {
					logger.debug(`override option enabled. overriding environment variable: ${key}`);
				} else {
					continue;
				}
			}

			process.env[key] = value;
		}
	});
}
