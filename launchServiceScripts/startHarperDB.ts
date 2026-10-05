import { hdbServer } from '../server/operationsServer.ts';
import * as env from '../utility/environment/environmentManager.ts';
import { runStartup } from '../utility/lifecycle.ts';
import logger from '../utility/logging/harper_logger.ts';
import { realExit } from '../server/threads/workerProcessGuard.ts';

async function launch() {
	env.initSync();
	await runStartup();
	await hdbServer();
}

launch().catch((error) => {
	logger.fatal('Failed to start the operations server', error);
	realExit(1);
});
