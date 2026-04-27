import { Resource as ResourceImport } from './resources/Resource.js';
import { server as serverImport } from './server/Server.js';
import { tables as dbTables, databases as dbDatabases } from './resources/databases.js';
import { BlobCreationOptions } from './resources/blob.js';
import { Logger } from './utility/logging/logger.js';

export { Resource } from './resources/Resource.js';
export type {
	Query,
	Context,
	Session,
	SourceContext,
	SubscriptionRequest,
	RequestTargetOrId,
} from './resources/ResourceInterface.js';
export { ResourceInterface } from './resources/ResourceInterface.js';
export type { User } from './security/user.js';
export type { RecordObject } from './resources/RecordEncoder.js';
export type { IterableEventQueue } from './resources/IterableEventQueue.js';
export { RequestTarget } from './resources/RequestTarget.js';
export { server } from './server/Server.js';
export { tables, databases, type Table } from './resources/databases.js';
export type { Attribute } from './resources/Table.js';

export { Scope } from './components/Scope.js';
export type { FilesOption, FilesOptionObject } from './components/deriveGlobOptions.js';
export type { FileAndURLPathConfig } from './components/Component.js';
export { OptionsWatcher, type Config, type ConfigValue } from './components/OptionsWatcher.js';
export {
	EntryHandler,
	type BaseEntry,
	type FileEntry,
	type EntryEvent,
	type AddFileEvent,
	type ChangeFileEvent,
	type UnlinkFileEvent,
	type FileEntryEvent,
	type AddDirectoryEvent,
	type UnlinkDirectoryEvent,
	type DirectoryEntryEvent,
} from './components/EntryHandler.js';

declare const logger: Logger;
export { type Logger, logger };

declare global {
	const tables: typeof dbTables;
	const logger: Logger;
	const databases: typeof dbDatabases;
	const server: typeof serverImport;
	const Resource: typeof ResourceImport;
	const createBlob: (
		source: Uint8Array | NodeJS.ReadableStream | string | Iterable<Uint8Array> | AsyncIterator<Uint8Array>,
		options?: BlobCreationOptions
	) => Blob;
}
