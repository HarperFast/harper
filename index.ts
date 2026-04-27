import workerThreads from 'node:worker_threads';
if (!workerThreads.isMainThread) {
	// Prevents server from starting in worker threads if this was directly imported from a non-server user thread
	if (!workerThreads.workerData) workerThreads.workerData = {};
	workerThreads.workerData.noServerStart = true;
}
import { globals } from './server/threads/threadServer.js';

// exported types are needed for parsing as well
export let Attribute = undefined;
export let Config = undefined;
export let ConfigValue = undefined;
export let Context = undefined;
export let FileAndURLPathConfig = undefined;
export let FilesOption = undefined;
export let FilesOptionObject = undefined;
export let IterableEventQueue = undefined;
export let Logger = undefined;
export let Query = undefined;
export let RecordObject = undefined;
export let RequestTarget = undefined;
export let RequestTargetOrId = undefined;
export let Resource = undefined;
export let ResourceInterface = undefined;
export let Scope = undefined;
export let Session = undefined;
export let SourceContext = undefined;
export let SubscriptionRequest = undefined;
export let Table = undefined;
export let User = undefined;

// these are all overwritten by the globals, but need to be here so that Node's static
// exports parser can analyze them
export let tables = {};
export let databases = {};
export let getUser = undefined;
export let server = {};
export let contentTypes = null;
export let threads = [];
export let logger = {};
Object.assign(exports, globals);
