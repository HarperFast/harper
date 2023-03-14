import { getMockLMDBPath } from '../test_utils.js';

let isSetup;
export async function setupTestApp() {
	if (isSetup) return;
	let path = getMockLMDBPath();
	process.env.ROOTPATH = path;
	// might need fileURLToPath
	process.env.RUN_HDB_APP = new URL('../testApp', import.meta.url);
	isSetup = true;
	const { startHTTPThreads } = await import('../../server/threads/socketRouter.js');
	await startHTTPThreads(2);
}