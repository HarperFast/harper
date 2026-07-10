import { parse } from 'dotenv';
import logger from '../utility/logging/harper_logger.ts';
import { Scope } from '../components/Scope.ts';
import { CONFIG_SHAPING_ENV_VARS } from '../config/componentEnvPrepass.ts';

export function handleApplication(scope: Scope) {
	const override = (scope.options.getAll() as { override?: boolean }).override ?? false;
	scope.handleEntry((entry) => {
		if (entry.eventType !== 'add') {
			scope.requestRestart();
			return;
		}
		logger.debug(`Loading env file: ${entry.absolutePath}`);
		for (const [key, value] of Object.entries(parse(entry.contents))) {
			if (CONFIG_SHAPING_ENV_VARS.includes(key)) {
				// covers components deployed after boot too — the boot-time pre-pass only sees
				// components present when the config is composed (#1513)
				logger.warn(
					`${key} from ${entry.absolutePath} cannot shape instance configuration (the config is composed before component .env files load, and components must not alter instance-wide config); set it in the process environment or harper-config.yaml`
				);
				// Enforce at the injection point: the trio must never reach process.env
				// from a component .env — anything downstream that (re)composes config
				// from process.env would otherwise silently honor it, re-inverting the
				// top-down config relationship.
				continue;
			}
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
