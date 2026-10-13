import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export function packageBindings(name: string) {
	return require.resolve('#src/utility/hdbTerms').endsWith('.ts')
		? require(fileURLToPath(import.meta.resolve(name)))
		: require(name);
}
