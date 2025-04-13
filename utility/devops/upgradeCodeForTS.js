const { existsSync, writeFileSync, readdirSync, readFileSync } = require('fs');
const path = require('path');

const DONT_CHANGE_COLON_VAR_FILES = ['ResourceBridge.ts', 'hdbTerms.ts'];
const SKIP_FILES = ['commonErrors.js'];
const SAFE_VAR_TRANSFORM = [
	'search_object',
	'writes_by_db',
	'query_string',
	'async_set_timeout',
	'component_errors',
	'config_log_path',
	'to_file',
	'to_stream',
	'level_defined',
	'from_defined',
	'until_defined',
];
const UNSAFE_VAR_TRANSFORM = [
	'settings_path',
	'install_user',
	'operation_function',
	'job_operation_function',
	'get_attributes',
	'keep_alive_timeout',
	'headers_timeout',
	'server_timeout',
	'https_enabled',
	'cors_enabled',
	'cors_accesslist',
	'local_studio_on',
	'hub_routes',
	'leaf_routes',
	'function_content',
	'known_hosts',
	'export_to_s3',
	'export_local',
	'attribute_permissions',
	'table_perms',
	'attribute_name',
	'update_node',
	'connected_nodes',
	'hash_attribute',
	'node_name',
	'failed_nodes',
	'ms_to_time',
	'system_info',
	'current_load',
	'no_projects',
	'log_to_file',
	'cert_file',
	'key_file',
	'ca_file',
	'pid_file_path',
	'config_file',
	'server_name',
	'sys_name',
	'decrypt_hash',
	'uri_encoded_d_hash',
	'uri_encoded_name',
	'sys_name_encoded',
	'operation_token',
	'refresh_token',
	'refresh_operation_token',
	'is_authority',
	'private_key_name',
	'private_key',
	'super_user',
	'cluster_user',
	'number_written',
	'job_id',
	'main_permissions',
	'schema_permissions',
	'hash_values',
	'operation_json',
	'from_date',
	'to_date',
	'db_size',
];
processDirectory(process.cwd().slice(0, process.cwd().indexOf('harperdb') + 'harperdb'.length));
function processDirectory(dir, type) {
	for (let entry of readdirSync(dir, { withFileTypes: true })) {
		console.log('processing', entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === 'ts-build' || entry.name.startsWith('.')) continue;
			processDirectory(path.join(dir, entry.name), entry.name.endsWith('Tests') ? 'test' : type);
		} else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.ts'))) {
			let filePath = path.join(dir, entry.name);
			let code = readFileSync(filePath, 'utf-8');
			let isTypeScript = filePath.endsWith('.ts');
			if (type === 'test') {
				code = code.replace(/(__[sg]et__)\(\s*'([a-z_]+[\w.]*)'/g, (match, etter, varName) => {
					if (UNSAFE_VAR_TRANSFORM.includes(varName)) {
						return match;
					}
					return `${etter}('${camelCase(varName)}'`;
				});
			} else {
				// add file extension
				code = code.replace(/require\('([^']+)'\)/g, (match, moduleId) => {
					return `require('${getModuleIdWithExtension(filePath, moduleId)}')`;
				});
				code = code.replace(/(import[^']+)'([^']+)'/g, (match, prefix, moduleId) => {
					return `${prefix}'${getModuleIdWithExtension(filePath, moduleId)}'`;
				});
				/* Replace require with import
				code = code.replace(/const ([^=]+)= require\('([^']+)'\)/g, (match, names, moduleId) => {
					return `import ${names}from '${moduleId}'`;
				});*/
				// snakeCase -> camelCase
				if (!SKIP_FILES.includes(entry.name)) {
					code = code.replace(
						/('[^'\n]*')|(\.*)([a-z][a-z\d]*_[a-z_\d]+)(:?)/g,
						(match, quoted, prefix, varName, suffix) => {
							if (quoted) return match;
							if (
								!SAFE_VAR_TRANSFORM.includes(varName) &&
								(prefix === '.' ||
									varName.includes('__') ||
									UNSAFE_VAR_TRANSFORM.includes(varName) ||
									(suffix === ':' && (!isTypeScript || DONT_CHANGE_COLON_VAR_FILES.includes(entry.name))))
							)
								return match;
							let newVarName = camelCase(varName);
							if (code.includes('function ' + newVarName)) return match; // don't change if there is a colliding function name
							return prefix + newVarName + suffix;
						}
					);
				}
			}
			console.log('Writing', filePath);
			writeFileSync(filePath, code);
			function camelCase(varName) {
				let parts = varName.split('_');
				return [parts[0], ...parts.slice(1).map((name) => name.charAt(0).toUpperCase() + name.slice(1))].join('');
			} // eslint-disable-line
		}
	}

	function getModuleIdWithExtension(startingPath, moduleId) {
		if (moduleId.startsWith('.')) {
			let modulePath = path.resolve(path.dirname(startingPath), moduleId);
			if (existsSync(modulePath + '.js')) return moduleId + '.js';
			if (existsSync(modulePath + '.ts')) return moduleId + '.ts';
			if (existsSync(modulePath + '.json')) return moduleId + '.json';
		}
		return moduleId;
	}
}
