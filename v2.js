const workerThreads = require('node:worker_threads');
if (!workerThreads.isMainThread) {
	// Prevents server from starting in worker threads if this was directly imported from a non-server user thread
	if (!workerThreads.workerData) workerThreads.workerData = {};
	workerThreads.workerData.noServerStart = true;
}
const { globals } = require('./server/threads/threadServer.js');

// exported types are needed for parsing as well
exports.Attribute = undefined;
exports.Config = undefined;
exports.ConfigValue = undefined;
exports.Context = undefined;
exports.FileAndURLPathConfig = undefined;
exports.FilesOption = undefined;
exports.FilesOptionObject = undefined;
exports.IterableEventQueue = undefined;
exports.Logger = undefined;
exports.Query = undefined;
exports.RecordObject = undefined;
exports.RequestTarget = undefined;
exports.RequestTargetOrId = undefined;
exports.Resource = undefined;
exports.ResourceInterface = undefined;
exports.Scope = undefined;
exports.Session = undefined;
exports.SourceContext = undefined;
exports.SubscriptionRequest = undefined;
exports.Table = undefined;
exports.User = undefined;

// these are all overwritten by the globals, but need to be here so that Node's static
// exports parser can analyze them
exports.tables = {};
exports.databases = {};
exports.getUser = undefined;
exports.server = {};
exports.contentTypes = null;
exports.threads = [];
exports.logger = {};
Object.assign(exports, globals);
