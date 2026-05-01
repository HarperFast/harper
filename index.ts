// Prevents server from starting in worker threads if this was directly imported from a non-server user thread
import workerThreads from 'node:worker_threads';
if (!workerThreads.isMainThread) {
	// @ts-expect-error - Idk this has been here for a while. Types say its readonly, but that must not be true.
	if (!workerThreads.workerData) workerThreads.workerData = {};
	workerThreads.workerData.noServerStart = true;
}

// Regular exports (don't require the same initialization as the globals at the end of this file do)
export { RequestTarget } from './resources/RequestTarget.ts';
export { getContext, getResponse, getUser } from './security/jsLoader.ts';

// Type only exports.
// Anything exported here will only be available as TypeScript types, not as values.
// For exporting values see below.
export type {
	Query,
	Context,
	Session,
	SourceContext,
	SubscriptionRequest,
	RequestTargetOrId,
	ResourceInterface,
} from './resources/ResourceInterface.ts';
export type { User } from './security/user.ts';
export type { RecordObject } from './resources/RecordEncoder.ts';
export type { IterableEventQueue } from './resources/IterableEventQueue.ts';
export type { Table } from './resources/databases.ts';
export type { Attribute } from './resources/Table.ts';
export type { Scope } from './components/Scope.ts';
export type { FilesOption, FilesOptionObject } from './components/deriveGlobOptions.ts';
export type { FileAndURLPathConfig } from './components/Component.ts';
export type { OptionsWatcher, Config, ConfigValue } from './components/OptionsWatcher.ts';
export type {
	EntryHandler,
	BaseEntry,
	FileEntry,
	EntryEvent,
	AddFileEvent,
	ChangeFileEvent,
	UnlinkFileEvent,
	FileEntryEvent,
	AddDirectoryEvent,
	UnlinkDirectoryEvent,
	DirectoryEntryEvent,
} from './components/EntryHandler.ts';

// Globals and values
// This section is responsible for creating the CJS exports map (for static analysis)
// as well as defining the globals and values exports.
// The stuff exported here are actually functional pieces of code.
// Importantly, do not import any values directly.
// For example, `import { tables } from './resources/databases.ts';` is NOT OKAY!
// This breaks Harper's dynamic runtime assignment of exports
// You MUST import as a type and then use `export declare const` instead.
// This results in the types being written to dist/index.d.ts, but not dist/index.js

// And for my sanity please keep these alphabetically sorted so we can ensure nothing is missing.

import type { contentTypes as ContentTypesImport } from './server/serverHelpers/contentTypes.ts';
import type { createBlob as CreateBlobImport } from './resources/blob.ts';
import type { databases as DatabasesImport } from './resources/databases.ts';
import type { Logger } from './utility/logging/logger.ts';
import type { operation as OperationImport } from './server/serverHelpers/serverUtilities.ts';
import type { Resource as ResourceImport } from './resources/Resource.ts';
import type { server as ServerImport } from './server/Server.ts';
import type { tables as TablesImport } from './resources/databases.ts';
type ThreadsImport = unknown[]; // TODO: figure out actual type for this
import type { transaction as TransactionImport } from './resources/transaction.ts';

declare global {
	const contentTypes: typeof ContentTypesImport;
	const createBlob: typeof CreateBlobImport;
	const databases: typeof DatabasesImport;
	const logger: Logger;
	const operation: typeof OperationImport;
	const Resource: typeof ResourceImport;
	const server: typeof ServerImport;
	const tables: typeof TablesImport;
	const threads: ThreadsImport;
	const transaction: typeof TransactionImport;
}

// Declare constant types so these are defined in `index.d.ts`
export declare const contentTypes: typeof ContentTypesImport;
export declare const createBlob: typeof CreateBlobImport;
export declare const databases: typeof DatabasesImport;
export declare const logger: Logger;
export declare const operation: typeof OperationImport;
export declare const Resource: typeof ResourceImport;
export declare const server: typeof ServerImport;
export declare const tables: typeof TablesImport;
export declare const threads: ThreadsImport;
export declare const transaction: typeof TransactionImport;

// Actual define the values on the `exports` for CJS static analysis
exports.contentTypes = null;
exports.createBlob = undefined;
exports.databases = {};
exports.logger = {};
exports.operation = undefined;
exports.Resource = undefined;
exports.server = {};
exports.tables = {};
exports.threads = [];
exports.transaction = undefined;

// And finally assign globals to exports.
// These values are populated at runtime by `_assignPackageExport()` in their respective modules
// (e.g. Resource.ts, databases.ts, Server.ts, etc.)
import { globals } from './server/threads/threadServer.js';

Object.assign(exports, globals);
