import logger from '../utility/logging/harper_logger.ts';

const warnedRoles = new Map<string, unknown>();

export function withoutSystemGrants<T extends { id?: string; __updatedtime__?: unknown; permission?: any }>(
	role: T,
	warnOnLegacy = true
): T {
	if (!role?.permission || !Object.hasOwn(role.permission, 'system')) return role;
	const { system, ...permission } = role.permission;
	const id = role.id;
	if (warnOnLegacy && (!warnedRoles.has(id) || warnedRoles.get(id) !== role.__updatedtime__)) {
		logger.warn(
			`Ignoring role-declared permissions on system tables for role '${id}': ${Object.keys(system?.tables ?? {}).join(', ')}. ` +
				'System table permissions are managed by Harper and cannot be granted through a role.'
		);
		warnedRoles.set(id, role.__updatedtime__);
	}
	return { ...role, permission };
}
