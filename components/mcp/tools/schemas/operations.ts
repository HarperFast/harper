/**
 * Hand-curated JSON Schemas for the operations-profile MCP tools.
 *
 * Why hand-curated: Harper's server-side validators are Joi, which doesn't
 * round-trip cleanly to JSON Schema. The MCP spec requires draft-07-ish
 * JSON Schema for tool inputSchema. Authoring these directly keeps the
 * schemas readable, easy to tweak per the LLM ergonomics we want, and
 * decoupled from server-side validation evolution.
 *
 * Each schema follows MCP convention: `type: 'object'` at the top, with
 * `properties` declared and a small `required` list when applicable.
 * Optional fields are listed but not required, so an LLM can call the
 * minimum-viable form.
 *
 * Coverage matches the v1 conservative `allow` default in the design
 * (#465 → Operations MCP). When operators expand `mcp.operations.allow`
 * beyond this list, ops without an entry here fall back to a permissive
 * `{ type: 'object' }` schema and a runtime-validates-as-it-goes posture
 * — better than silently dropping them from the tool surface.
 */

/** Permissive default for any opted-in operation that doesn't have a hand-curated schema yet. */
export const PERMISSIVE_SCHEMA: object = {
	type: 'object',
	additionalProperties: true,
	description: 'Free-form arguments — Harper validates server-side and returns a structured error if invalid.',
};

/**
 * Map of operation name → input schema. Lookup misses fall back to
 * `PERMISSIVE_SCHEMA`. Keys mirror `OPERATIONS_ENUM` values.
 */
export const OPERATION_INPUT_SCHEMAS: Record<string, object> = {
	// ─── describe_* ───────────────────────────────────────────────────────
	describe_all: {
		type: 'object',
		properties: {
			skip_record_count: {
				type: 'boolean',
				description:
					'Omit each table’s `record_count` (and `estimated_record_range`) to skip the per-table count scan, which dominates latency on large databases. Defaults to false.',
			},
		},
		description: 'Returns the full schema tree: every database, table, and attribute the caller can describe.',
	},
	describe_schema: {
		type: 'object',
		properties: {
			schema: { type: 'string', description: 'Database name (legacy: "schema"). Required.' },
			database: { type: 'string', description: 'Database name (preferred). Required if `schema` is omitted.' },
			skip_record_count: {
				type: 'boolean',
				description: 'Omit each table’s `record_count` to skip the count scan. Defaults to false.',
			},
		},
	},
	describe_database: {
		type: 'object',
		properties: {
			database: { type: 'string', description: 'Database name. Required.' },
			skip_record_count: {
				type: 'boolean',
				description: 'Omit each table’s `record_count` to skip the count scan. Defaults to false.',
			},
		},
		required: ['database'],
	},
	describe_table: {
		type: 'object',
		properties: {
			database: { type: 'string', description: 'Database name.' },
			schema: { type: 'string', description: 'Legacy alias for `database`.' },
			table: { type: 'string', description: 'Table name. Required.' },
			skip_record_count: {
				type: 'boolean',
				description:
					'Omit `record_count` (and `estimated_record_range`) to skip the count scan and return schema/metadata faster. Defaults to false.',
			},
		},
		required: ['table'],
	},

	// ─── list_* ───────────────────────────────────────────────────────────
	list_users: {
		type: 'object',
		properties: {},
		description: 'Lists every Harper user the caller can see (requires super_user).',
	},
	list_roles: {
		type: 'object',
		properties: {},
		description: 'Lists every Harper role the caller can see (requires super_user).',
	},
	list_metrics: {
		type: 'object',
		properties: {},
		description: 'Lists analytics metric names currently being collected.',
	},
	list_deployments: {
		type: 'object',
		properties: {},
		description: 'Lists deployed component versions in this Harper instance.',
	},

	// ─── search_* ─────────────────────────────────────────────────────────
	search_by_hash: {
		type: 'object',
		properties: {
			database: { type: 'string', description: 'Database name.' },
			schema: { type: 'string', description: 'Legacy alias for `database`.' },
			table: { type: 'string', description: 'Table name. Required.' },
			hash_values: {
				type: 'array',
				items: { type: ['string', 'number'] },
				description: 'Primary-key values to fetch. Required.',
			},
			get_attributes: {
				type: 'array',
				items: { type: 'string' },
				description: 'Attribute names to include in the response. Defaults to all.',
			},
		},
		required: ['table', 'hash_values'],
	},
	search_by_id: {
		type: 'object',
		properties: {
			database: { type: 'string' },
			schema: { type: 'string', description: 'Legacy alias for `database`.' },
			table: { type: 'string' },
			ids: { type: 'array', items: { type: ['string', 'number'] }, description: 'Primary-key values. Required.' },
			get_attributes: { type: 'array', items: { type: 'string' } },
		},
		required: ['table', 'ids'],
	},
	search_by_value: {
		type: 'object',
		properties: {
			database: { type: 'string' },
			schema: { type: 'string', description: 'Legacy alias for `database`.' },
			table: { type: 'string' },
			search_attribute: { type: 'string', description: 'Attribute to match.' },
			search_value: { description: 'Value to match (any JSON type).' },
			get_attributes: { type: 'array', items: { type: 'string' } },
		},
		required: ['table', 'search_attribute', 'search_value'],
	},
	search_by_conditions: {
		type: 'object',
		properties: {
			database: { type: 'string' },
			schema: { type: 'string', description: 'Legacy alias for `database`.' },
			table: { type: 'string' },
			operator: { type: 'string', enum: ['and', 'or'], description: 'How to combine conditions. Defaults to "and".' },
			conditions: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						search_attribute: { type: 'string' },
						search_type: {
							type: 'string',
							enum: ['equals', 'contains', 'starts_with', 'ends_with', 'greater_than', 'less_than', 'between'],
						},
						search_value: {},
					},
					required: ['search_attribute', 'search_type', 'search_value'],
				},
			},
			get_attributes: { type: 'array', items: { type: 'string' } },
			offset: { type: 'number', minimum: 0 },
			limit: { type: 'number', minimum: 1 },
		},
		required: ['table', 'conditions'],
	},
	search: {
		type: 'object',
		properties: {
			database: { type: 'string' },
			schema: { type: 'string', description: 'Legacy alias for `database`.' },
			table: { type: 'string' },
			operation: { type: 'object', description: 'Search operation descriptor; varies by search kind.' },
		},
		required: ['table', 'operation'],
		description: 'Generic search dispatcher; prefer the specific search_by_* operations when possible.',
	},
	search_jobs_by_start_date: {
		type: 'object',
		properties: {
			from_date: { type: 'string', description: 'ISO 8601 timestamp; lower bound.' },
			to_date: { type: 'string', description: 'ISO 8601 timestamp; upper bound.' },
		},
		required: ['from_date', 'to_date'],
	},

	// ─── get_* ────────────────────────────────────────────────────────────
	get_job: {
		type: 'object',
		properties: {
			id: { type: 'string', description: 'Job id. Required.' },
		},
		required: ['id'],
	},
	get_configuration: {
		type: 'object',
		properties: {},
		description: 'Returns the resolved server configuration (with secrets redacted).',
	},
	get_backup: {
		type: 'object',
		properties: {
			database: { type: 'string', description: 'Database to back up. Required.' },
			table: { type: 'string', description: 'Optional single table within the database.' },
		},
		required: ['database'],
	},

	// ─── read_* / system_information ──────────────────────────────────────
	read_log: {
		type: 'object',
		properties: {
			from: { type: 'string', description: 'ISO 8601 lower bound. Optional.' },
			until: { type: 'string', description: 'ISO 8601 upper bound. Optional.' },
			limit: { type: 'number', minimum: 1, description: 'Max entries to return.' },
			start: { type: 'number', minimum: 0, description: 'Pagination offset.' },
			order: { type: 'string', enum: ['asc', 'desc'] },
			level: { type: 'string', enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'notify'] },
		},
	},
	read_audit_log: {
		type: 'object',
		properties: {
			database: { type: 'string' },
			schema: { type: 'string', description: 'Legacy alias for `database`.' },
			table: { type: 'string' },
			search_type: { type: 'string', enum: ['timestamp', 'username', 'hash_value'] },
			search_values: { type: 'array', items: { type: ['string', 'number'] } },
		},
		required: ['table'],
	},
	read_transaction_log: {
		type: 'object',
		properties: {
			database: { type: 'string' },
			schema: { type: 'string', description: 'Legacy alias for `database`.' },
			table: { type: 'string' },
			from: { type: 'number', description: 'Inclusive lower-bound transaction timestamp (ms).' },
			until: { type: 'number', description: 'Exclusive upper-bound transaction timestamp (ms).' },
			limit: { type: 'number', minimum: 1 },
		},
		required: ['table'],
	},
	system_information: {
		type: 'object',
		properties: {
			attributes: {
				type: 'array',
				items: { type: 'string' },
				description: 'Restrict the response to the named sections (e.g. ["cpu","memory"]).',
			},
		},
		description: 'Returns host metrics: CPU, memory, disk, network, replication state.',
	},
	get_status: {
		type: 'object',
		properties: {
			id: {
				type: 'string',
				description: 'Status entry id. When omitted, returns aggregated status across threads.',
			},
		},
	},
	get_analytics: {
		type: 'object',
		properties: {
			metric: { type: 'string', description: 'Metric name (use list_metrics to discover available metrics).' },
			get_attributes: {
				type: 'array',
				items: { type: 'string' },
				description: 'Attribute names to project; defaults to all.',
			},
			start_time: {
				type: ['number', 'string'],
				description: 'ISO 8601 timestamp or epoch ms — inclusive window start.',
			},
			end_time: { type: ['number', 'string'], description: 'ISO 8601 timestamp or epoch ms — exclusive window end.' },
			log: {
				type: 'string',
				description: 'Transaction log name to filter on (rocksdb-txnlog-stats metric).',
			},
		},
		required: ['metric'],
	},
	describe_metric: {
		type: 'object',
		properties: {
			metric: { type: 'string', description: 'Metric name to describe (use list_metrics to discover).' },
		},
		required: ['metric'],
	},
	list_agent_sessions: {
		type: 'object',
		properties: {
			limit: { type: 'integer', minimum: 1, description: 'Max sessions to return.' },
		},
	},
	get_metrics: {
		type: 'object',
		properties: {
			metric: { type: 'string', description: 'Metric name (use list_metrics to discover available metrics).' },
			get_attributes: {
				type: 'array',
				items: { type: 'string' },
				description: 'Attribute names to project; defaults to all.',
			},
			start_time: {
				type: ['number', 'string'],
				description: 'ISO 8601 timestamp or epoch ms — inclusive window start.',
			},
			end_time: { type: ['number', 'string'], description: 'ISO 8601 timestamp or epoch ms — exclusive window end.' },
			log: {
				type: 'string',
				description: 'Transaction log name to filter on (rocksdb-txnlog-stats metric).',
			},
		},
		required: ['metric'],
	},
};
