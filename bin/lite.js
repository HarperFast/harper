require('./dev');
const { startHTTPThreads, startSocketServer } = require('../server/threads/socketRouter');

startHTTPThreads(0, true);
startSocketServer(9925);
startSocketServer(9926);
