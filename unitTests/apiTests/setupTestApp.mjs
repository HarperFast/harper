import { getMockLMDBPath } from '../test_utils.js';
import { fileURLToPath } from 'url';
let isSetup;
export async function setupTestApp() {
	// exit if it is already setup or we are running in the browser
	if (isSetup || typeof navigator !== 'undefined') return;
	let path = getMockLMDBPath();
	process.env.STORAGE_PATH = path;
	// make it easy to see what is going on when unit testing
	process.env.LOGGING_STDSTREAMS = 'true';
	// might need fileURLToPath
	process.env.RUN_HDB_APP = fileURLToPath(new URL('../testApp', import.meta.url));
	isSetup = true;
	const { startHTTPThreads } = await import('../../server/threads/socketRouter.js');
	await startHTTPThreads(1);
}