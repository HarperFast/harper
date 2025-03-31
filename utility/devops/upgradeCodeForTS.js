const { existsSync, writeFileSync, readdirSync, readFileSync } = require('fs');
const path = require('path');
processDirectory(process.cwd().slice(0, process.cwd().indexOf('harperdb') + 'harperdb'.length));
function processDirectory(dir) {
	for (let entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name.endsWith('Tests')) return;
			processDirectory(path.join(dir, entry.name));
		} else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.ts'))) {
			let filePath = path.join(dir, entry.name);
			let code = readFileSync(filePath, 'utf-8');
			if (code.length > 40000) {
				console.log('big file', filePath);
				return;
			} // skip large files
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
			// snake_case -> camelCase
			code = code.replace(/('[^'\n]+')|([^a-z])([a-z]+_[a-z_]+)(.)/g, (match, quoted, prefix, varName, suffix) => {
				if (quoted) return match;
				if (prefix === '.' || suffix === ':') return match;
				let parts = varName.split('_');
				return (
					prefix +
					[parts[0], ...parts.slice(1).map((name) => name.charAt(0).toUpperCase() + name.slice(1))].join('') +
					suffix
				);
			});
			writeFileSync(filePath, code);
		}
	}

	function getModuleIdWithExtension(startingPath, moduleId) {
		if (moduleId.startsWith('.')) {
			let modulePath = path.relative(path.dirname(startingPath), moduleId);
			if (existsSync(modulePath + '.js')) return moduleId + '.js';
			if (existsSync(modulePath + '.ts')) return moduleId + '.ts';
			if (existsSync(modulePath + '.json')) return moduleId + '.json';
		}
		return moduleId;
	}
}
