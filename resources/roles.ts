import { dirname } from 'path';
import { getDatabases, table } from './databases';
import { alterRole, addRole } from '../security/role';
import { parseDocument } from 'yaml';
import { isEqual } from 'lodash';
const USERS_NOT_DBS = ['super_user', 'cluster_user', 'structure_user'];
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
	 * @param roles_content
	 */
	async function handleFile(roles_content) {
		let roles_to_define = parseDocument(roles_content.toString(), { simpleKeys: true }).toJSON();
		for (let role_name in roles_to_define) {
			let role = roles_to_define[role_name];
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
			for (let db_name in role.permission) {
				if (USERS_NOT_DBS.includes(db_name)) continue;
				let db = role.permission[db_name];
				if (!db.tables) {
					// we allow the tables object to be collapsed into the root object for convenience
					role.permission[db_name] = db = { tables: db };
				}
				for (let table_name in db.tables) {
					let table = db.tables[table_name];
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
			role.role = role.id = role_name;
			await ensureRole(role);
		}
	}
}
async function ensureRole(role) {
	const role_table = getDatabases().system.hdb_role;
	// if the role already exists, we need to update it
	for await (let existing_role of role_table.search([{ attribute: 'role', value: role.role }])) {
		// use the existing role id so we can update in place. Legacy roles may have a UUID for the id instead of the role name
		const { __createdtime__, __updatedtime__, ...existing_role_data } = existing_role;
		if (isEqual(existing_role_data, role)) {
			return;
		}
		role.id = existing_role.id;
		return alterRole(role);
	}
	return addRole(role);
}

// we can define these on the main thread
export const startOnMainThread = start;
// useful for testing
