import { OPERATIONS_ENUM } from './hdbTerms.ts';

/**
 * Predefined operation permission groups for use with `operations` role permissions.
 * Group names can be included in the `operations` array alongside individual operation names.
 */
export const OPERATION_PERMISSION_GROUPS = {
	/**
	 * Read-only data operations: searches, SQL (DML type further enforced by table CRUD perms),
	 * schema describes, and user/analytics reads. Does NOT include admin reads
	 * (get_configuration, logs, component views) — add those explicitly alongside this group
	 * when elevated admin visibility is needed.
	 */
	read_only: [
		OPERATIONS_ENUM.SEARCH,
		OPERATIONS_ENUM.SEARCH_BY_CONDITIONS,
		OPERATIONS_ENUM.SEARCH_BY_HASH,
		OPERATIONS_ENUM.SEARCH_BY_ID,
		OPERATIONS_ENUM.SEARCH_BY_VALUE,
		OPERATIONS_ENUM.SQL,
		OPERATIONS_ENUM.DESCRIBE_ALL,
		OPERATIONS_ENUM.DESCRIBE_SCHEMA,
		OPERATIONS_ENUM.DESCRIBE_DATABASE,
		OPERATIONS_ENUM.DESCRIBE_TABLE,
		OPERATIONS_ENUM.USER_INFO,
		OPERATIONS_ENUM.GET_JOB,
		OPERATIONS_ENUM.GET_ANALYTICS,
		OPERATIONS_ENUM.LIST_METRICS,
		OPERATIONS_ENUM.DESCRIBE_METRIC,
	],
	/**
	 * Elevated read-only access to server configuration, logs, and component views.
	 * All ops here are SU-only and granted via the operations SU bypass.
	 * Combine with `read_only` for a full studio/dashboard read role:
	 * `operations: ['read_only', 'admin_read']`
	 */
	admin_read: [
		OPERATIONS_ENUM.GET_CONFIGURATION,
		OPERATIONS_ENUM.READ_LOG,
		OPERATIONS_ENUM.READ_AUDIT_LOG,
		OPERATIONS_ENUM.GET_CUSTOM_FUNCTIONS,
		OPERATIONS_ENUM.GET_CUSTOM_FUNCTION,
		OPERATIONS_ENUM.GET_COMPONENTS,
		OPERATIONS_ENUM.GET_COMPONENT_FILE,
	],
	/**
	 * Everything in `read_only` plus full data manipulation (insert, update, upsert, delete)
	 * and bulk load. Does NOT include schema DDL (create_attribute), user/role management,
	 * or admin reads (get_configuration, logs). Add those explicitly when needed.
	 */
	standard_user: [
		// All read_only ops
		OPERATIONS_ENUM.SEARCH,
		OPERATIONS_ENUM.SEARCH_BY_CONDITIONS,
		OPERATIONS_ENUM.SEARCH_BY_HASH,
		OPERATIONS_ENUM.SEARCH_BY_ID,
		OPERATIONS_ENUM.SEARCH_BY_VALUE,
		OPERATIONS_ENUM.SQL,
		OPERATIONS_ENUM.DESCRIBE_ALL,
		OPERATIONS_ENUM.DESCRIBE_SCHEMA,
		OPERATIONS_ENUM.DESCRIBE_DATABASE,
		OPERATIONS_ENUM.DESCRIBE_TABLE,
		OPERATIONS_ENUM.USER_INFO,
		OPERATIONS_ENUM.GET_JOB,
		OPERATIONS_ENUM.GET_ANALYTICS,
		OPERATIONS_ENUM.LIST_METRICS,
		OPERATIONS_ENUM.DESCRIBE_METRIC,
		// Data manipulation
		OPERATIONS_ENUM.INSERT,
		OPERATIONS_ENUM.UPDATE,
		OPERATIONS_ENUM.UPSERT,
		OPERATIONS_ENUM.DELETE,
		// Bulk load
		OPERATIONS_ENUM.CSV_DATA_LOAD,
		OPERATIONS_ENUM.CSV_FILE_LOAD,
		OPERATIONS_ENUM.CSV_URL_LOAD,
		OPERATIONS_ENUM.IMPORT_FROM_S3,
	],
} as const;

const validOps: Set<string> = new Set(Object.values(OPERATIONS_ENUM));
const validGroups: Set<string> = new Set(Object.keys(OPERATION_PERMISSION_GROUPS));

/**
 * Validates that every entry in an operations array is a known operation name or group name.
 * Returns the first invalid entry, or null if all entries are valid.
 */
export function validateOperations(operations: readonly unknown[]): string | null {
	for (const op of operations) {
		if (typeof op !== 'string' || (!validOps.has(op) && !validGroups.has(op))) {
			return String(op);
		}
	}
	return null;
}

/**
 * Expands an operations array into a Set of individual operation names,
 * resolving group names (e.g. 'read_only') to their member operations.
 */
export function expandOperationsPerms(operations: readonly string[]): Set<string> {
	const allowedOps = new Set<string>();
	for (const item of operations) {
		const group = OPERATION_PERMISSION_GROUPS[item as keyof typeof OPERATION_PERMISSION_GROUPS];
		if (group) {
			for (const op of group) allowedOps.add(op);
		} else {
			allowedOps.add(item);
		}
	}
	return allowedOps;
}
