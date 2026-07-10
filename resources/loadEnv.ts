import { parse } from 'dotenv';
import logger from '../utility/logging/harper_logger.ts';
import { Scope } from '../components/Scope.ts';
<<<<<<< HEAD
=======
import { isEncryptedEnvValue } from '../utility/envFile.ts';
import { deferEncryptedEnvValue, getSecretDecryptor } from './secretDecryptor.ts';
import { CONFIG_SHAPING_ENV_VARS } from '../config/componentEnvPrepass.ts';
>>>>>>> 0e80b6bdb (Merge pull request #1580 from HarperFast/fix/load-env-config-order-1513)

export function handleApplication(scope: Scope) {
	const override = (scope.options.getAll() as { override?: boolean }).override ?? false;
	scope.handleEntry((entry) => {
		if (entry.eventType !== 'add') {
			scope.requestRestart();
			return;
		}
		logger.debug(`Loading env file: ${entry.absolutePath}`);
<<<<<<< HEAD
		for (const [key, value] of Object.entries(parse(entry.contents))) {
=======
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
				// entry is also queued so a decryptor that registers later (custody can come up after
				// component `.env` loading) replays it into process.env; until then the app sees a
				// missing var (and should fail on it) rather than receiving ciphertext.
				if (!decryptor) {
					logger.error(
						`Environment variable ${key} from ${entry.absolutePath} is encrypted but no env-secret decryptor is registered yet (the Harper Pro env-secrets component is required); deferring`
					);
					deferEncryptedEnvValue({ key, rawValue, sourcePath: entry.absolutePath, override });
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

			if (CONFIG_SHAPING_ENV_VARS.includes(key)) {
				// covers components deployed after boot too — the boot-time pre-pass only sees
				// components present when the config is composed (#1513)
				logger.warn(
					`${key} from ${entry.absolutePath} cannot shape instance configuration (the config is composed before component .env files load, and components must not alter instance-wide config); set it in the process environment or harper-config.yaml`
				);
				// Enforce at the injection point: the trio must never reach process.env
				// from a component .env — anything downstream that (re)composes config
				// from process.env (e.g. #1618/#1726's OptionsWatcher) would otherwise
				// silently honor it, re-inverting the top-down config relationship.
				continue;
			}
>>>>>>> 0e80b6bdb (Merge pull request #1580 from HarperFast/fix/load-env-config-order-1513)
			if (process.env[key] !== undefined) {
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
