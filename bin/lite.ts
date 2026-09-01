import { startHTTPThreads } from '../server/threads/socketRouter.ts';
startHTTPThreads(1).catch((error) => {
	console.error(error);
	process.exit(1);
});
