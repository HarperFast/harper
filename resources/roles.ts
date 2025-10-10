import { getDatabases } from './databases.ts';
import { alterRole, addRole } from '../security/role.js';
import { parseDocument } from 'yaml';
import { isEqual } from 'lodash';
const USERS_NOT_DBS = ['super_user', 'structure_user'];
/**
 * This is the component for handling role declarations in the HarperDB system. This will read roles.yaml for role
 * definitions and ensure that they are created in the system database.
 */
export function start({ ensureTable }) {
	return {
		handleFile,
		setupFile: handleFile,
	};

	/**
	 * This function will handle the roles.yaml file content that has been read, and ensure that the roles are translated to
	 * the right shape and created in the system database.
	 * @param rolesContent
	 */
	async function handleFile(rolesContent) {
		let rolesToDefine = parseDocument(rolesContent.toString(), { simpleKeys: true }).toJSON();
		for (let roleName in rolesToDefine) {
			let role = rolesToDefine[roleName];
			if (!role.permission) {
				// we allow the permission object to be collapsed into the root object for convenience
				role = {
					permission: role,
				};
				if (role.permission.access) {
					// this is the designed property object for user-defined flags and access levels
					role.access = role.permission.access;
					delete role.permission.access;
				}
			}
			for (let dbName in role.permission) {
				if (USERS_NOT_DBS.includes(dbName)) continue;
				let db = role.permission[dbName];
				if (!db.tables) {
					// we allow the tables object to be collapsed into the root object for convenience
					role.permission[dbName] = db = { tables: db };
				}
				for (let tableName in db.tables) {
					let table = db.tables[tableName];
					// ensure that all the flags are boolean
					table.read = Boolean(table.read);
					table.insert = Boolean(table.insert);
					table.update = Boolean(table.update);
					table.delete = Boolean(table.delete);
					if (table.attributes) {
						// allow attributes to be defined with an object, translating to an array
						let attributes = [];
						for (let attribute_name in table.attributes) {
							let attribute = table.attributes[attribute_name];
							attribute.attribute_name = attribute_name;
							attributes.push(attribute);
						}
						table.attribute_permissions = attributes;
						delete table.attributes;
					}
					if (table.attribute_permissions) {
						if (!Array.isArray(table.attribute_permissions))
							throw new Error('attribute_permissions must be an array if defined');
						for (let attribute of table.attribute_permissions) {
							// ensure that all the flags are boolean
							attribute.read = Boolean(attribute.read);
							attribute.insert = Boolean(attribute.insert);
							attribute.update = Boolean(attribute.update);
						}
					} else table.attribute_permissions = null;
				}
			}
			role.role = role.id = roleName;
			await ensureRole(role);
		}
	}
}
async function ensureRole(role) {
	const roleTable = getDatabases().system.hdb_role;
	// if the role already exists, we need to update it
	for await (let existingRole of roleTable.search([{ attribute: 'role', value: role.role }])) {
		// use the existing role id so we can update in place. Legacy roles may have a UUID for the id instead of the role name
		const { __createdtime__, __updatedtime__, ...existingRoleData } = existingRole;
		if (isEqual(existingRoleData, role)) {
			return;
		}
		role.id = existingRole.id;
		return alterRole(role);
	}
	return addRole(role);
}

// we can define these on the main thread
export const startOnMainThread = start;
// useful for testing
