module.exports = function(fileInfo, api) {
  const j = api.jscodeshift;
  const root = j(fileInfo.source);

  const nodeBuiltins = new Set([
    'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
    'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
    'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector',
    'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
    'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'timers',
    'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
    'worker_threads', 'zlib'
  ]);

  function getModName(val) {
    if (nodeBuiltins.has(val) && !val.startsWith('node:')) {
      return `node:${val}`;
    }
    return val;
  }

  // Handle: const foo = require('bar');
  root.find(j.VariableDeclaration).forEach(path => {
    path.node.declarations.forEach(decl => {
      if (decl.init && decl.init.type === 'CallExpression' && decl.init.callee.name === 'require') {
        const modName = getModName(decl.init.arguments[0].value);
        if (decl.id.type === 'Identifier') {
          // const foo = require('bar') -> import foo from 'bar'
          const importDecl = j.importDeclaration(
            [j.importDefaultSpecifier(j.identifier(decl.id.name))],
            j.literal(modName)
          );
          j(path).replaceWith(importDecl);
        } else if (decl.id.type === 'ObjectPattern') {
          // const { foo, bar } = require('baz') -> import { foo, bar } from 'baz'
          const specifiers = decl.id.properties.map(prop => {
            return j.importSpecifier(j.identifier(prop.key.name), j.identifier(prop.value.name));
          });
          const importDecl = j.importDeclaration(specifiers, j.literal(modName));
          j(path).replaceWith(importDecl);
        }
      } else if (decl.init && decl.init.type === 'MemberExpression' && decl.init.object.type === 'CallExpression' && decl.init.object.callee.name === 'require') {
        // Handle: const foo = require('bar').foo;
        const modName = getModName(decl.init.object.arguments[0].value);
        const propName = decl.init.property.name;
        if (decl.id.type === 'Identifier') {
          // import { foo } from 'bar' if propName == decl.id.name
          // import { foo as bar } from 'bar' otherwise
          const specifier = j.importSpecifier(j.identifier(propName), j.identifier(decl.id.name));
          const importDecl = j.importDeclaration([specifier], j.literal(modName));
          j(path).replaceWith(importDecl);
        }
      }
    });
  });

  // Handle: require('foo');
  root.find(j.ExpressionStatement).forEach(path => {
    if (path.node.expression.type === 'CallExpression' && path.node.expression.callee.name === 'require') {
      const modName = getModName(path.node.expression.arguments[0].value);
      const importDecl = j.importDeclaration([], j.literal(modName));
      j(path).replaceWith(importDecl);
    }
  });

  // Handle module.exports = ...
  root.find(j.AssignmentExpression).forEach(path => {
    if (path.node.left.type === 'MemberExpression' &&
        path.node.left.object.name === 'module' &&
        path.node.left.property.name === 'exports') {
      
      const exportDecl = j.exportDefaultDeclaration(path.node.right);
      j(path.parentPath).replaceWith(exportDecl);
    } else if (path.node.left.type === 'MemberExpression' &&
               path.node.left.object.name === 'exports') {
      // exports.foo = bar -> export const foo = bar
      const exportDecl = j.exportNamedDeclaration(
        j.variableDeclaration('const', [
          j.variableDeclarator(j.identifier(path.node.left.property.name), path.node.right)
        ])
      );
      j(path.parentPath).replaceWith(exportDecl);
    }
  });

  let source = root.toSource({ quote: 'single' });

  // Add __dirname / __filename polyfills if needed
  if (source.includes('__dirname') || source.includes('__filename')) {
    const polyfill = `
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
`;
    // Find the last import
    const imports = root.find(j.ImportDeclaration);
    if (imports.length > 0) {
      const lastImport = imports.at(-1).get();
      j(lastImport).insertAfter(polyfill);
      source = root.toSource({ quote: 'single' }); // Re-generate source
    } else {
      source = polyfill + '\n' + source;
    }
  }

  // Small fix: the polyfill insertAfter might not output well as raw string, let's fix it by regex if jscodeshift failed.
  if ((source.includes('__dirname') || source.includes('__filename')) && !source.includes('import.meta.url')) {
     const polyfill = `\nimport { fileURLToPath } from 'node:url';\nimport { dirname } from 'node:path';\nconst __filename = fileURLToPath(import.meta.url);\nconst __dirname = dirname(__filename);\n`;
     // Insert after use strict or at top
     source = source.replace(/^(?:'use strict';\n)?/m, `$&${polyfill}`);
  }

  return source;
};
