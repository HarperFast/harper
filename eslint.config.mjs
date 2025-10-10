/**
 * ESLint configuration extending Harper shared config
 * Uses flat config format (ESLint 9+)
 * @see https://eslint.org/docs/latest/use/configure/
 */
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default defineConfig([
	// Global ignores
	{
		ignores: ['node_modules/**', 'dist/**'],
	},
	// Enable Node.js globals for all of our source files
	{
		files: ['**/*.{js,ts,mjs,mts,cjs,cts}'],
		plugins: { js },
		extends: ['js/recommended'],
		languageOptions: { globals: globals.node },
		// Customize rules for all files here
		rules: {
			
		},
	},
	{
		files: ['**/*.js'],
		languageOptions: { sourceType: 'commonjs' },
		// Customize Rules specifically for the CommonJS files here
		rules: {},
	},

	// TypeScript-specific configuration
	{
		files: ['**/*.{ts,mts,cts}'],
		// Eventually we may want to use strict and stylistic configs instead of recommended
		extends: [...tseslint.configs.recommendedTypeChecked],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		// Customize Rules for TypeScript files here
		rules: {},
	},

	// Disable conflicting ESLint formatting rules
	// Prettier formatting is only enforced via `npm run format:check` and editor integrations
	// More information here: https://prettier.io/docs/integrating-with-linters.html
	prettier,
]);
