import { startHTTPThreads, startSocketServer } from '../server/threads/socketRouter.js';

startHTTPThreads(0, true);
startSocketServer(9925);
startSocketServer(9926);
