const { existsSync, writeFileSync, readdirSync, readFileSync } = require('fs');
const path = require('path');
const VAR_EXCLUSION_LIST = [];

const DONT_CHANGE_COLON_VAR_FILES = ['ResourceBridge.ts', 'hdbTerms.ts'];
const SAFE_VAR_TRANSFORM = ['search_object'];
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
			code = code.replace(/(import[^']*? from )'([^']+)'/g, (match, prefix, moduleId) => {
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
					prefix === '.' ||
					(suffix === ':' &&
						!SAFE_VAR_TRANSFORM.includes(varName) &&
						(!isTypeScript || DONT_CHANGE_COLON_VAR_FILES.includes(entry.name)))
				)
					return match;
				if (VAR_EXCLUSION_LIST.includes(varName)) return match;
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
