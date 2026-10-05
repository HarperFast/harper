// Prevents server from starting in worker threads if this was directly imported from a non-server user thread
import workerThreads from 'node:worker_threads';
if (!workerThreads.isMainThread) {
	// @ts-expect-error - Idk this has been here for a while. Types say its readonly, but that must not be true.
	if (!workerThreads.workerData) workerThreads.workerData = {};
	workerThreads.workerData.noServerStart = true;
}

// Regular exports (don't require the same initialization as the globals at the end of this file do)
export { RequestTarget } from './resources/RequestTarget.ts';
export { flushDatabases } from './resources/databases.ts';
export {
	registerReplicatedApplyFailureListener,
	unregisterReplicatedApplyFailureListener,
	type ReplicatedApplyFailure,
	type ReplicatedApplyFailureListener,
} from './resources/replicatedApplyFailure.ts';
export { getContext, getResponse, getUser } from './security/jsLoader.ts';
// An untagged error from a `server.getUser` override is treated as an internal fault; these tag one
// as a rejected credential, which authentication defers to the route owner instead (#2703).
export { markCredentialRejection, credentialRejectionError } from './security/credentialRejection.ts';
// Code-first schema authoring: declare a table as a TypeScript value; the returned
// handle is the live, registered table class with per-verb shapes inferred from the definition.
export { defineTable, types } from './resources/defineTable.ts';

// The per-method request contract. `defineResource`/`Resource.withSchema` type
// handlers from a runtime contract and feed validation + OpenAPI + MCP from one declaration; `t` and
// `schemaOf` are the built-in query/body vocabulary (both reduce to a JsonSchemaFragment).
export { defineResource, t, schemaOf, projectTableFragment } from './resources/defineResource.ts';

// Type only exports.
// Anything exported here will only be available as TypeScript types, not as values.
// For exporting values see below.
export type {
	Query,
	Context,
	Session,
	SourceContext,
	SubscriptionRequest,
	RecordLockOptions,
	RequestTargetOrId,
	ResourceInterface,
	WritableRecord,
} from './resources/ResourceInterface.ts';
export type { User } from './security/user.ts';
export type { RecordObject } from './resources/RecordEncoder.ts';
export type { IterableEventQueue } from './resources/IterableEventQueue.ts';
export type { Table } from './resources/databases.ts';
export type { Attribute } from './resources/Table.ts';
// Code-first schema types: the table handle and field model. Per-verb record shapes are
// discoverable on the handle itself: (typeof Track)['$record' | '$insert' | '$upsert' | '$patch' | '$query'].
export type {
	TableHandle,
	Field,
	DateField,
	RelationField,
	Shape,
	Flags,
	DefineTableOptions,
} from './resources/defineTable.ts';
// Request-contract types.
export type {
	Contract,
	VerbSchemas,
	VerbName,
	Schema,
	SchemaSource,
	Projection,
	PathParams,
	TypedTarget,
	TypedSearchParams,
	ImplFor,
	SchemaClass,
} from './resources/defineResource.ts';
export type { Scope } from './components/Scope.ts';
export type {
	ModelBackend,
	ModelCapabilities,
	DefineBackendSpec,
	Capability,
	ModelRouter,
	RouteRequest,
	EmbedOpts,
	GenerateOpts,
	GenerateInput,
	GenerateResult,
	GenerateChunk,
	BackendOpts,
	AccountingContext,
	ModelCallResult,
	TokenUsage,
	Message,
	ToolDef,
	ToolCall,
	ToolHandler,
	ToolHandlerContext,
	ToolTraceEntry,
	ConversationAppender,
	ConversationTurn,
	DecideInput,
	DecideOpts,
	RecordedDecideOpts,
	Decision,
	RecordedDecision,
	DecisionSchema,
	DecisionLeaf,
	FieldDecision,
	DecisionOutcome,
	DecisionRecord,
	OutcomeReport,
	OutcomeTruth,
	OutcomeAction,
} from './resources/models/types.ts';
export type {
	CalibrationBudgets,
	CalibrationConfig,
	CalibrationReport,
	CalibrationRunResult,
	CalibrationSummary,
} from './resources/models/calibrationStore.ts';
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

import runtimeGlobals from './globals.js';
import './server/threads/threadServer.ts';
import type { contentTypes as ContentTypesImport } from './server/serverHelpers/contentTypes.ts';
import type { createBlob as CreateBlobImport } from './resources/blob.ts';
import type { databases as DatabasesImport } from './resources/databases.ts';
import type { Logger } from './utility/logging/logger.ts';
import type { models as ModelsImport } from './resources/models/Models.ts';
import type { operation as OperationImport } from './server/serverHelpers/serverUtilities.ts';
import type { Resource as ResourceImport } from './resources/Resource.ts';
import type { SecretsView as SecretsImport } from './components/componentSecrets.ts'; // per-component secrets view (#1550)
import type { server as ServerImport } from './server/Server.ts';
import type { tables as TablesImport } from './resources/databases.ts';
type ThreadsImport = unknown[] & {
	sendToThread?: (threadId: number, message: any) => boolean;
	onMessageByType?: (type: string, listener: (...args: any[]) => any) => void;
};
import type { transaction as TransactionImport } from './resources/transaction.ts';

// These names are exposed TWO ways that resolve to the SAME live, process-wide value:
//   1. as ambient globals (the `declare global` block below), and
//   2. as named exports of the `harper` package (the `export const` block below).
// At runtime each is populated in place by `_assignPackageExport(name, value)` (see globals.js),
// which assigns BOTH `global[name]` and `exports[name]` to the one shared instance. So
// `tables`/`databases`/etc. are not per-module or per-compartment copies: the bare global `tables`
// and `import { tables } from 'harper'` are the same object, available in any module Harper loads —
// resources, plugins, and e.g. a Vite SSR entry (whose `node_modules/harper` is symlinked to this
// running install, see components/componentLoader.ts). Application VM compartments are *seeded* from
// this process global, not given an alternate set (see security/jsLoader.ts `getGlobalObject`).
declare global {
	const contentTypes: typeof ContentTypesImport;
	const createBlob: typeof CreateBlobImport;
	const databases: typeof DatabasesImport;
	const logger: Logger;
	const models: typeof ModelsImport;
	const operation: typeof OperationImport;
	const Resource: typeof ResourceImport;
	const secrets: SecretsImport;
	const server: typeof ServerImport;
	const tables: typeof TablesImport;
	const threads: ThreadsImport;
	const transaction: typeof TransactionImport;
}

// The CommonJS default is the live object; its ESM namespace named properties are early snapshots.
export const contentTypes = runtimeGlobals.contentTypes as typeof ContentTypesImport;
export const createBlob = runtimeGlobals.createBlob as typeof CreateBlobImport;
export const databases = runtimeGlobals.databases as typeof DatabasesImport;
export const logger = runtimeGlobals.logger as Logger;
export const models = runtimeGlobals.models as typeof ModelsImport;
export const operation = runtimeGlobals.operation as typeof OperationImport;
export const Resource = runtimeGlobals.Resource as typeof ResourceImport;
export const secrets = runtimeGlobals.secrets as SecretsImport;
export const server = runtimeGlobals.server as typeof ServerImport;
export const tables = runtimeGlobals.tables as typeof TablesImport;
export const threads = runtimeGlobals.threads as ThreadsImport;
export const transaction = runtimeGlobals.transaction as typeof TransactionImport;

if (typeof exports !== 'undefined') Object.assign(exports, runtimeGlobals);
