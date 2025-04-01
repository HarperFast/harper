const { existsSync, writeFileSync, readdirSync, readFileSync } = require('fs');
const path = require('path');

const DONT_CHANGE_COLON_VAR_FILES = ['ResourceBridge.ts', 'hdbTerms.ts'];
const SAFE_VAR_TRANSFORM = ['search_object', 'main_permissions', 'schema_permissions', 'writes_by_db', 'query_string'];
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
];
processDirectory(process.cwd().slice(0, process.cwd().indexOf('harperdb') + 'harperdb'.length));
function processDirectory(dir) {
	for (let entry of readdirSync(dir, { withFileTypes: true })) {
		console.log('processing', entry.name);
		if (entry.isDirectory()) {
			if (
				entry.name === 'node_modules' ||
				entry.name === 'ts-build' ||
				entry.name.startsWith('.') ||
				entry.name.endsWith('Tests')
			)
				continue;
			processDirectory(path.join(dir, entry.name));
		} else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.ts'))) {
			let filePath = path.join(dir, entry.name);
			let code = readFileSync(filePath, 'utf-8');
			let isTypeScript = filePath.endsWith('.ts');
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
			code = code.replace(/('[^'\n]*')|(\.*)([a-z]+_[a-z_]+)(:?)/g, (match, quoted, prefix, varName, suffix) => {
				if (quoted) return match;
				if (
					!SAFE_VAR_TRANSFORM.includes(varName) &&
					(prefix === '.' ||
						varName.includes('__') ||
						UNSAFE_VAR_TRANSFORM.includes(varName) ||
						(suffix === ':' && (!isTypeScript || DONT_CHANGE_COLON_VAR_FILES.includes(entry.name))))
				)
					return match;
				let parts = varName.split('_');
				let newVarName = [parts[0], ...parts.slice(1).map((name) => name.charAt(0).toUpperCase() + name.slice(1))].join(
					''
				);
				if (code.includes('function ' + newVarName)) return match; // don't change if there is a colliding function name
				return prefix + newVarName + suffix;
			});
			console.log('Writing', filePath);
			writeFileSync(filePath, code);
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
