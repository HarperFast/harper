import { parse } from 'dotenv';
import logger from '../utility/logging/harper_logger.ts';
import { Scope } from '../components/Scope.ts';

export function handleApplication(scope: Scope) {
	const override = (scope.options.getAll() as { override?: boolean }).override ?? false;
	scope.handleEntry((entry) => {
		if (entry.eventType !== 'add') {
			scope.requestRestart();
			return;
		}
		logger.debug(`Loading env file: ${entry.absolutePath}`);
		for (const [key, value] of Object.entries(parse(entry.contents))) {
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
