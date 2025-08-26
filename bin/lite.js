require('./dev.js');
const { startHTTPThreads, startSocketServer } = require('../server/threads/socketRouter.ts');

startHTTPThreads(0, true);
startSocketServer(9925);
startSocketServer(9926);
