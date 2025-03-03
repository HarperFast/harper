import { parse } from 'dotenv';
import logger from '../utility/logging/harper_logger';

export function start() {
	return {
		handleFile: (contents, _, filePath) => {
			logger.debug(`Loading env file: ${filePath}`);
			Object.assign(process.env, parse(contents));
		}
	}
}