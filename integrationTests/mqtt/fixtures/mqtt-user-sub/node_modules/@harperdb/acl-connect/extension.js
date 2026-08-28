import { findTopicsForUser, mqttPermissionCheck, resolveTopic } from './permission.js';
import { startMonitoring } from './monitorEvents.js';

let sys_monitoring_table;
export function start({ ensureTable, database, monitoring }) {
	return {
		handleFile,
		setupFile: handleFile,
	};

	async function handleFile(content, url_path, file_path, resources) {
		const connect_config = JSON.parse(content); // parse the provided config file
		const database_name = database || 'data';
		const tables = databases[database_name];
		const resources_to_permission = new Map();
		// iterate through all the ACLs and get the appropriate resource or table that we are going to extend
		for (const acl of connect_config.acls) {
			if (typeof acl.topicFilter !== 'string') throw new Error('ACL must have a topicFilter (as a string)');
			const path = acl.topicFilter.split('/');
			let resource_to_permission;
			let resource_path;
			for (let i = path.length; i >= 1; i--) {
				// If there is an existing exported resource, we will use that, trying for most specific first.
				// This allows for an exported resource to be mapped to a sub-topic, which can be used to define
				// separate sub-topics to have different table backings.
				resource_path = path.slice(0, i).join('/');
				if (resource_path === '$SYS') {
					// we specifically look for the special $SYS topic, which is used for monitoring, and setup monitoring
					// on-demand if the user has defined an ACL for it
					if (!sys_monitoring_table) {
						sys_monitoring_table = startMonitoring(ensureTable);
					}
					resource_to_permission = sys_monitoring_table;
					break;
				}
				// now look for user exported resources
				resource_to_permission = resources.get(resource_path)?.Resource;
				if (resource_to_permission) break;
			}
			if (!resource_to_permission) {
				// otherwise we will use the table, ensuring that it exists first
				resource_path = path[0];
				const table = ensureTable({ table: resource_path, database: database_name, attributes: [] });
				resource_to_permission = table;
			}
			// add all the ACLs to the resource that we will apply the permissions to
			let resource_entry = resources_to_permission.get(resource_path);
			if (!resource_entry) resources_to_permission.set(resource_path, resource_entry = { resource: resource_to_permission, acls: [] });
			resource_entry.acls.push(acl);
		}
		for (let [resource_path, resource_entry] of resources_to_permission) {
			// now apply the set of ACLs to the resource, extending the resource to define access
			const new_resource_class = applyPermissions(resource_path.split('/'), resource_entry);
			// And export the new resource class with permissions applied (potentially re-exporting user resource with
			// permissions applied)
			resources.set(resource_path, new_resource_class);
		}
	}
}
function applyPermissions(path, { resource, acls }) {
	return class extends resource {
		/**
		 * Check if the user is allowed to subscribe to (read) the topic (resource)
		 * @param user
		 * @param query
		 * @param context
		 * @return {*|boolean}
		 */
		allowRead(user, query, context) {
			const topic = resolveTopic(context?.topic);
			const allowed_topics = findTopicsForUser(acls, user, context?.session?.sessionId, false);
			if (mqttPermissionCheck(topic, allowed_topics)) {
				return true;
			}
			return super.allowRead(user);
		}

		/**
		 * Check if the user is allowed to publish to (create) the topic (resource)
		 * @param user
		 * @param query
		 * @param context
		 * @return {*|boolean}
		 */
		allowCreate(user, query, context) {
			return this._allowUpdateAndCreate(user, query, context) || super.allowCreate(user);
		}

		/**
		 * Check if the user is allowed to update the topic (resource)
		 * @param user
		 * @param query
		 * @param context
		 * @return {*|boolean}
		 */
		allowUpdate(user, query, context) {
			return this._allowUpdateAndCreate(user, query, context) || super.allowUpdate(user);
		}

		/**
		 * Check if the user is allowed to publish and update the topic (resource)
		 * @private
		 * @param user
		 * @param query
		 * @param context
		 * @return {boolean}
		 */
		_allowUpdateAndCreate(user, query, context) {
			const topic = resolveTopic(path, this.getId());
			const allowed_topics = findTopicsForUser(acls, user, context?.session?.sessionId, true);
			return mqttPermissionCheck(topic, allowed_topics);
		}
	}
}

export const startOnMainThread = start;