import { parse } from 'dotenv';
import logger from '../utility/logging/harper_logger';

export function start({ override }: { override: boolean }) {
	return {
		handleFile: (contents, _, filePath) => {
			logger.debug(`Loading env file: ${filePath}`);
			for (const [key, value] of Object.entries(parse(contents))) {
				if (process.env[key] !== undefined) {
					logger.warn(`Environment variable conflict: ${key} from ${filePath} is already set on process.env`);
					if (override) {
						logger.debug(`override option enabled. overriding environment variable: ${key}`);
					} else {
						continue;
					}
				}

				process.env[key] = value;
			}
		},
	};
}
