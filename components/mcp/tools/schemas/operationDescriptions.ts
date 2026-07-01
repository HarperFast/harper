/**
 * Hand-authored MCP tool descriptions for Harper operations.
 *
 * Authoring process: each entry was authored by reading the corresponding
 * handler implementation in `OPERATION_FUNCTION_MAP` — its leading JSDoc,
 * its actual behavior (mutations, side effects, RBAC, hazards), and its
 * relationship to sibling operations — and writing a short, verb-led
 * sentence grounded in that code. The path:line citation above each entry
 * points to the handler's declaration so reviewers can verify in one click.
 *
 * Authoring rubric:
 *   1. Verb-led sentence: "Creates …", "Returns …", "Restarts …", "Lists …".
 *   2. Disambiguate from siblings when useful (e.g. search_by_id vs
 *      search_jobs_by_start_date). The LLM uses these to choose tools.
 *   3. One cost/hazard sentence for heavy or destructive calls.
 *   4. ≤ 400 chars per entry. Long descriptions waste context and get
 *      truncated by some MCP clients.
 *   5. No PR/issue references in descriptions — they're shown to LLMs at
 *      tool-selection time, not consumed by human reviewers.
 *
 * Coverage target: every operation matching the v1 DEFAULT_ALLOW glob
 * expansion, plus every destructive operation an operator might opt into
 * via `mcp.operations.allow`. Out-of-core operations (e.g. harper-pro's
 * `cluster_status`) cannot have entries here — their authoritative
 * description belongs alongside their implementation.
 *
 * Transitional status: this catalog is the in-core fill until #878
 * (introspectable operations registry) ships, at which point each
 * operation's description lives with its schema and its handler in one
 * place and this file is retired.
 */
export const OPERATION_DESCRIPTIONS: Record<string, string> = {
	// ─── DEFAULT_ALLOW: describe_* ────────────────────────────────────────
	// describe_all: dataLayer/schemaDescribe.ts:22 — Returns the schema tree for every accessible database/table.
	describe_all: 'Returns the full schema tree: every database, table, and attribute the caller can describe.',
	// describe_schema: dataLayer/schemaDescribe.ts:239 — Schema metadata filtered by role permissions.
	describe_schema: "Returns metadata for a schema and its tables, filtered by the caller's role permissions.",
	// describe_database: dataLayer/schemaDescribe.ts:239 — Alias for describe_schema.
	describe_database:
		"Alias for describe_schema. Returns metadata for a database and its tables, filtered by the caller's role permissions.",
	// describe_table: dataLayer/schemaDescribe.ts:108 — Per-table metadata: attributes, indexes, size, audit status.
	describe_table:
		"Returns one table's metadata: attributes, types, indexes, primary key, size, record count, and audit status. Filtered by attribute_permissions. Use to discover what attributes a search_* call can filter on.",
	// describe_metric: resources/analytics/read.ts:242 — Metric definition for the analytics table.
	describe_metric:
		'Returns attribute names and types for a specific metric in the analytics table. Pair with get_analytics or list_metrics.',

	// list_agent_sessions: agent/operations.ts:101 — Super-user list of running agent sessions.
	list_agent_sessions:
		'Lists running MCP agent sessions. Requires super_user. Use to surface what the platform is currently running on behalf of which operator.',

	// ─── DEFAULT_ALLOW: list_* ────────────────────────────────────────────
	// list_users: security/user.ts:283 — Users + roles + permissions, secrets scrubbed.
	list_users:
		'Lists all system users with their roles and permissions. Password and token data are scrubbed from the output.',
	// list_roles: security/role.ts:200 — Role catalog with permissions.
	list_roles: 'Returns all system roles with their associated permission structures.',
	// list_metrics: resources/analytics/read.ts:180 — Metric catalog over a time window.
	list_metrics: 'Lists built-in and custom metrics from the analytics table within a specified time window.',
	// list_deployments: components/deploymentOperations.ts:50 — Deployment history with filtering and pagination.
	list_deployments:
		'Lists deployments from system.hdb_deployment with optional filtering by project, status, and date range, plus pagination.',

	// ─── DEFAULT_ALLOW: search_* ──────────────────────────────────────────
	// search_by_conditions: dataLayer/search.ts:6 — Multi-condition search with comparators.
	search_by_conditions:
		'Searches records by an array of conditions with comparators (equals, greater_than, between, etc.). The most expressive search variant.',
	// search_by_hash: dataLayer/search.ts:11 — Primary-key fetch (1-N).
	search_by_hash:
		'Returns records by primary-key value(s). Fast single-record or batch lookup; pass an array of hashes for multi-record fetch.',
	// search_by_id: dataLayer/search.ts:11 — Alias of search_by_hash.
	search_by_id: 'Alias for search_by_hash. Returns records by primary-key value(s).',
	// search_by_value: dataLayer/search.ts:21 — Single-attribute equality/match search.
	search_by_value:
		'Searches records by matching a single attribute value, with optional sorting. Lighter alternative to search_by_conditions when the predicate is one attribute.',
	// search: server/serverHelpers/serverUtilities.ts (evaluateSQL) — SQL SELECT entry point.
	search:
		'Executes a SQL SELECT statement and returns matching records as an async iterable. Use sql for INSERT/UPDATE/DELETE instead.',
	// search_jobs_by_start_date: server/jobs/jobs.ts:48 — Job audit by start-time window.
	search_jobs_by_start_date:
		'Lists background jobs started in a UTC time window. Useful for auditing recent imports, backups, exports, restarts. Pair with get_job for full status.',

	// ─── DEFAULT_ALLOW: explicit safe getters ─────────────────────────────
	// get_job: server/jobs/jobs.ts:35 — One job's state + result by id.
	get_job:
		'Returns one background job by id, with status and result payload (export, backup, deploy, restart, csv loads).',
	// get_status: server/status/index.ts:104 — Status KV entry; aggregated when id omitted.
	get_status:
		'Returns one entry from the in-memory status KV that components publish health and progress to. With no id, returns aggregated status across threads. Safe to poll. Use system_information for server-level health.',
	// get_analytics: resources/analytics/read.ts:44 — Metric series read with filtering + windowing.
	get_analytics:
		'Returns analytics metric values with optional attribute filtering, time windowing, and result coalescing. Pair with list_metrics to discover available metrics.',
	// system_information: utility/environment/systemInformation.ts:695 — Host + process metrics snapshot.
	system_information:
		'Snapshot of host metrics: CPU, memory, disk, network, replication lag, process stats, table sizes, database metrics. Heavy — scope with the `attributes` argument (e.g. ["memory","replication"]). Do not poll faster than 10s.',

	// ─── DEFAULT_ALLOW: read_* ────────────────────────────────────────────
	// read_log: utility/logging/readLog.ts:24 — Application log slice with filtering.
	read_log:
		'Returns Harper application logs filtered by date range, log level, and search terms, with pagination support.',
	// read_audit_log: dataLayer/readAuditLog.ts (default export) — Per-table mutation history.
	read_audit_log:
		'Returns mutation history (insert/update/delete) for a table, filterable by timestamp, username, or primary-key value. Requires audit logging enabled. Deprecated in favor of read_transaction_log.',
	// read_transaction_log: utility/logging/transactionLog.ts:14 — Transaction log slice.
	read_transaction_log:
		'Returns transaction-log entries for a table within an optional timestamp range. The modern successor to read_audit_log.',

	// ─── Opt-in writes ────────────────────────────────────────────────────
	// insert: dataLayer/insert.ts:116 — Insert N records; auto-assigns primary key if missing.
	insert:
		'Inserts new records into a table. Records missing a primary key are auto-keyed and returned in the response. Fails if a record exists with the same primary key.',
	// update: dataLayer/insert.ts:149 — Update records by primary key.
	update:
		'Updates existing records identified by primary key. Patch semantics: only listed attributes are changed; omitted attributes retain their prior values.',
	// upsert: dataLayer/insert.ts:266 — Atomic insert-or-update.
	upsert: 'Inserts new records or updates existing ones, keyed by primary key. Atomic across the batch.',
	// delete: dataLayer/delete.ts:120 — Delete records by primary key hash; returns counts.
	delete:
		'Deletes records by primary-key value(s). Returns the count of deleted records and any hashes that did not match. Destructive — confirm before invoking.',
	// sql: server/serverHelpers/serverUtilities.ts (evaluateSQL) — Arbitrary SQL.
	sql: 'Executes arbitrary SQL — SELECT, INSERT, UPDATE, or DELETE. For SELECT-only queries prefer search (clearer intent, safer audit trail).',

	// ─── Opt-in bulk loads (async jobs) ───────────────────────────────────
	// csv_data_load: dataLayer/bulkLoad.ts:45 — Load CSV from an inline string into a table.
	csv_data_load:
		'Parses CSV data from a string argument and bulk-loads it into a table. Returns a job id; poll get_job for status. Validates attribute permissions before scheduling.',
	// csv_file_load: dataLayer/bulkLoad.ts:169 — Load CSV from a local file path.
	csv_file_load:
		'Loads CSV from a local server-side file path into a table. Returns a job id; poll get_job. Requires file-read permission on the path. Costly disk I/O for large files.',
	// csv_url_load: dataLayer/bulkLoad.ts:117 — Download CSV from URL, then load.
	csv_url_load:
		'Downloads CSV from a URL and loads it into a table. Returns a job id; poll get_job. Costly network + disk I/O; the URL must be reachable from the Harper host.',
	// import_from_s3: dataLayer/bulkLoad.ts (importFromS3) — Bulk import from S3.
	import_from_s3:
		'Imports CSV or JSON from private S3 buckets into a table. Returns a job id; poll get_job. Requires AWS credentials configured on the Harper host. Costly network operation.',

	// ─── Opt-in exports (async jobs) ──────────────────────────────────────
	// export_local: dataLayer/export.ts:38 — Export table to local disk.
	export_local:
		'Exports table records to the local filesystem in JSON or CSV format. Returns a job id; poll get_job. Requires the target path to be writable by Harper.',
	// export_to_s3: dataLayer/export.ts:188 — Export table to S3.
	export_to_s3:
		'Exports table records to S3 in JSON or CSV format. Returns a job id; poll get_job. Costly network operation; requires AWS credentials configured on the Harper host.',

	// ─── Opt-in DDL: create_* / drop_* ────────────────────────────────────
	// create_schema: dataLayer/schema.ts:48 — Create a schema/database.
	create_schema:
		'Creates a new schema (database). Validates the schema name and emits a schema-change signal to all workers and cluster nodes.',
	// create_database: dataLayer/schema.ts:48 — Alias of create_schema.
	create_database: 'Alias for create_schema. Creates a new database (schema).',
	// create_table: dataLayer/schema.ts:85 — Create a table with primary key.
	create_table:
		'Creates a new table in a schema with the specified primary key. Optionally sets data residency for clustered deployments.',
	// create_attribute: dataLayer/schema.ts:312 — Add an attribute to a table.
	create_attribute:
		'Adds a new attribute to a table. Validates uniqueness and emits a schema-change signal so workers and cluster nodes pick up the new column.',
	// drop_schema: dataLayer/schema.ts:144 — Delete a schema and its tables.
	drop_schema:
		'Deletes a schema and every table within it. Destructive and replicated to all cluster nodes — confirm scope before invoking.',
	// drop_database: dataLayer/schema.ts:144 — Alias of drop_schema.
	drop_database:
		'Alias for drop_schema. Deletes a database and every table within it. Destructive and replicated to cluster nodes.',
	// drop_table: dataLayer/schema.ts:180 — Delete a table.
	drop_table: 'Deletes a table and its metadata from a schema. Destructive and replicated to cluster nodes.',
	// drop_attribute: dataLayer/schema.ts:222 — Drop an attribute and its data.
	drop_attribute:
		"Removes an attribute and its stored data from a table. Destructive — the attribute's historical values are unrecoverable.",
	// get_backup: dataLayer/schema.ts:343 — Snapshot a schema/database.
	get_backup: "Creates a backup of a database via the storage engine's backup utility. May be heavy on disk I/O.",
	// cleanup_orphan_blobs: dataLayer/schema.ts:347 — Reclaim unreferenced blob files.
	cleanup_orphan_blobs:
		'Identifies and removes orphaned blob files from database storage. Runs asynchronously; check logs for completion.',

	// ─── Users / roles ────────────────────────────────────────────────────
	// add_user: security/user.ts:129 — Create a user with role + password.
	add_user:
		'Creates a new Harper user with username, password, and role. Requires super_user. Username is immutable after creation — use drop_user + add_user to rename.',
	// alter_user: security/user.ts:172 — Mutate user fields; broadcasts cluster event.
	alter_user:
		"Updates an existing user's password, role, or active flag. Broadcasts a user-change event to all cluster nodes. Username cannot be changed.",
	// drop_user: security/user.ts:236 — Delete a user.
	drop_user:
		"Deletes a Harper user. Broadcasts a user-change event to all cluster nodes. Destructive — the user's session and refresh tokens stop working immediately.",
	// user_info: security/user.ts:255 — Caller\'s own user info.
	user_info:
		"Returns the authenticated caller's own user info: username, active status, and role permissions. Sensitive fields are scrubbed.",
	// add_role: security/role.ts:42 — Create a role with permission structure.
	add_role: 'Creates a new role with the given permission structure. Validates role uniqueness.',
	// alter_role: security/role.ts:96 — Mutate role permissions; broadcasts.
	alter_role:
		"Updates an existing role's permission structure. Broadcasts a role-change event so cluster nodes pick up the new permissions.",
	// drop_role: security/role.ts:126 — Delete a role; refuses if assigned.
	drop_role:
		'Deletes a role. Refused if any active user is still assigned to the role — drop or reassign those users first.',
	// create_authentication_tokens: security/tokenAuthentication.ts:86 — Mint operation + refresh token pair.
	create_authentication_tokens:
		'Creates a JWT operation token and a refresh token after validating credentials. Stores the refresh token on the user record.',
	// refresh_operation_token: security/tokenAuthentication.ts:171 — Mint new operation token from refresh.
	refresh_operation_token:
		'Issues a new operation token using a valid refresh token, without re-authenticating with username/password.',
	// login: security/auth.ts:371 — Session-based login.
	login:
		'Authenticates the caller and creates a session entry. Requires sessions to be enabled in Harper configuration.',
	// logout: security/auth.ts:381 — Session-based logout.
	logout: "Clears the caller's session. Requires sessions to be enabled.",

	// ─── Configuration & process control ──────────────────────────────────
	// get_configuration: config/configUtils.js (getConfiguration) — Read config.
	get_configuration:
		'Returns the current Harper configuration values. May expose TLS certs, S3 credentials, and auth secrets — guard tightly and never enable on the MCP allow list without intent.',
	// set_configuration: config/configUtils.js (setConfiguration) — Mutate config + persist.
	set_configuration:
		'Updates Harper configuration parameters and persists to harperdb-config.yaml. Affects all workers. Most settings require restart to take effect. Destructive — confirm scope before invoking.',
	// restart: bin/restart.ts:40 — Whole-process restart.
	restart:
		'Restarts the Harper process. Disconnects all clients; replication catches up on reconnect. Can take up to 30 seconds. Destructive — confirm before invoking.',
	// restart_service: bin/restart.ts:100 — Restart a specific worker pool.
	restart_service:
		'Restarts a specific service (http_workers, custom_functions). Less disruptive than restart. Replicated to cluster nodes when requested.',
	// catchup: server/serverHelpers/serverUtilities.ts (catchup) — Replay a transaction batch.
	catchup:
		'Replays a batch of insert/update/upsert/delete transactions against a table channel sequentially. Used by replication; rarely invoked directly.',

	// ─── Retention / housekeeping ─────────────────────────────────────────
	// delete_files_before: dataLayer/delete.ts:30 — Delete file-backed records older than a cutoff.
	delete_files_before:
		'Deletes file-backed records older than an ISO 8601 timestamp. Does NOT remove values from the database — only file payloads. Cost depends on file volume.',
	// delete_records_before: dataLayer/delete.ts:30 — Alias of delete_files_before.
	delete_records_before:
		'Alias for delete_files_before. Deletes file-backed records older than a timestamp. Cost depends on volume.',
	// delete_audit_logs_before: dataLayer/delete.ts:77 — Prune audit entries before cutoff.
	delete_audit_logs_before:
		'Deletes audit/transaction-log entries before a timestamp. Deprecated; prefer delete_transaction_logs_before. Costly on tables with deep audit history.',
	// delete_transaction_logs_before: utility/logging/transactionLog.ts:43 — Prune transaction log before cutoff.
	delete_transaction_logs_before:
		'Deletes transaction-log entries before a timestamp for a specified table. Destructive bulk operation; pruned entries cannot be recovered.',

	// get_metrics: resources/analytics/read.ts (analytics.getOp) — Alias for get_analytics.
	get_metrics:
		'Alias for get_analytics. Returns analytics metric values with optional attribute filtering and time windowing. Pair with list_metrics to discover available metrics.',
};
