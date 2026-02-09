export { ResourceV2 as Resource } from './resources/ResourceV2.ts';
export type {
	Context,
	Query,
	RequestTargetOrId,
	Session,
	SourceContext,
	SubscriptionRequest,
} from './resources/ResourceInterface.ts';
export { ResourceInterfaceV2 as ResourceInterface } from './resources/ResourceInterfaceV2.ts';
export type { User } from './security/user.ts';
export type { RecordObject } from './resources/RecordEncoder.ts';
export type { IterableEventQueue } from './resources/IterableEventQueue.ts';
export { RequestTarget } from './resources/RequestTarget.ts';
export { server } from './server/Server';
export { tables, databases, type Table } from './resources/databases.ts';
export type { Attribute } from './resources/Table.ts';

import type { Logger } from './components/Logger.ts';
declare const logger: Logger;
export { type Logger, logger };

export type { Scope } from './components/Scope.ts';
export type { FilesOption, FilesOptionObject } from './components/deriveGlobOptions.ts';
export type { FileAndURLPathConfig } from './components/Component.ts';
export { OptionsWatcher, type Config, type ConfigValue } from './components/OptionsWatcher.ts';
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
} from './components/EntryHandler.ts';
