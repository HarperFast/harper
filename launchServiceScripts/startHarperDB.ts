import { hdbServer } from '../server/operationsServer.ts';
import * as env from '../utility/environment/environmentManager.ts';
import { runStartup } from '../utility/lifecycle.ts';
import logger from '../utility/logging/harper_logger.ts';
import { realExit } from '../server/threads/workerProcessGuard.ts';
import { enableCompileCache } from '../server/threads/compileCache.ts';
import { CONFIG_PARAMS } from '../utility/hdbTerms.ts';

async function launch() {
	env.initSync();
	enableCompileCache(env.get(CONFIG_PARAMS.ROOTPATH));
	await runStartup();
	await hdbServer();
}

launch().catch((error) => {
	logger.fatal('Failed to start the operations server', error);
	realExit(1);
});
