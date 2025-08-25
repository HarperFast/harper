export const DEFAULT_CONFIG = {
	rest: true,
	graphqlSchema: {
		files: '*.graphql'
	},
	roles: {
		files: 'roles.yaml'
	},
	jsResource: {
		files: 'resources.js'
	},
	fastifyRoutes: {
		files: 'routes/*.js'
	},
	static: {
		files: 'web/**'
	}
};