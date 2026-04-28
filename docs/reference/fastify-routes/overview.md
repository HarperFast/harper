---
title: Define Fastify Routes
---

<!-- Source: versioned_docs/version-4.7/developers/applications/define-routes.md (primary) -->

# Define Fastify Routes

:::note
Fastify routes are discouraged in favor of modern routing with [Custom Resources](../resources/overview.md), but remain a supported feature for backwards compatibility and specific use cases.
:::

Harper provides a build-in plugin for loading [Fastify](https://www.fastify.io/) routes as a way to define custom endpoints for your Harper application. While we generally recommend building your endpoints/APIs with Harper's [REST interface](../rest/overview.md) for better performance and standards compliance, Fastify routes can provide an extensive API for highly customized path handling. Below is a very simple example of a route declaration.

The fastify route handler can be configured in your application's config.yaml (this is the default config if you used the [application template](https://github.com/HarperDB/application-template)):

```yaml
fastifyRoutes:
  files: routes/*.js # specify the location of route definition modules
```

By default, route URLs are configured to be:

```
<Instance URL>:<HTTP Port>/<Project name>/<Route URL>
```

However, you can specify the path to be `/` if you wish to have your routes handling the root path of incoming URLs.

- The route below, using the default config, within the **dogs** project, with a route of **breeds** would be available at **[http://localhost:9926/dogs/breeds](http://localhost:9926/dogs/breeds)**.

In effect, this route is just a pass-through to Harper. The same result could have been achieved by hitting the core Harper API, since it uses **hdbCore.preValidation** and **hdbCore.request**, which are defined in the "helper methods" section, below.

```javascript
export default async (server, { hdbCore, logger }) => {
	server.route({
		url: '/',
		method: 'POST',
		preValidation: hdbCore.preValidation,
		handler: hdbCore.request,
	});
};
```

## Custom Handlers

For endpoints where you want to execute multiple operations against Harper, or perform additional processing (like an ML classification, or an aggregation, or a call to a 3rd party API), you can define your own logic in the handler. The function below will execute a query against the dogs table, and filter the results to only return those dogs over 4 years in age.

**IMPORTANT: This route has NO preValidation and uses hdbCore.requestWithoutAuthentication, which- as the name implies- bypasses all user authentication. See the security concerns and mitigations in the "helper methods" section, below.**

```javascript
export default async (server, { hdbCore, logger }) => {
    server.route({
        url: '/:id',
        method: 'GET',
        handler: (request) => {
            request.body= {
                operation: 'sql',
                sql: `SELECT * FROM dev.dog WHERE id = ${request.params.id}`
            };

          const result = await hdbCore.requestWithoutAuthentication(request);
          return result.filter((dog) => dog.age > 4);
        }
    });
}
```

## Custom preValidation Hooks

The simple example above was just a pass-through to Harper- the exact same result could have been achieved by hitting the core Harper API. But for many applications, you may want to authenticate the user using custom logic you write, or by conferring with a 3rd party service. Custom preValidation hooks let you do just that.

Below is an example of a route that uses a custom validation hook:

```javascript
import customValidation from '../helpers/customValidation';

export default async (server, { hdbCore, logger }) => {
	server.route({
		url: '/:id',
		method: 'GET',
		preValidation: (request) => customValidation(request, logger),
		handler: (request) => {
			request.body = {
				operation: 'sql',
				sql: `SELECT * FROM dev.dog WHERE id = ${request.params.id}`,
			};

			return hdbCore.requestWithoutAuthentication(request);
		},
	});
};
```

Notice we imported customValidation from the **helpers** directory. To include a helper, and to see the actual code within customValidation, see [Helper Methods](#helper-methods).

## Helper Methods

When declaring routes, you are given access to 2 helper methods: hdbCore and logger.

### hdbCore

hdbCore contains three functions that allow you to authenticate an inbound request, and execute operations against Harper directly, by passing the standard Operations API.

#### preValidation

This is an array of functions used for fastify authentication. The second function takes the authorization header from the inbound request and executes the same authentication as the standard Harper Operations API (for example, `hdbCore.preValidation[1](req, resp, callback)`). It will determine if the user exists, and if they are allowed to perform this operation. **If you use the request method, you have to use preValidation to get the authenticated user**.

#### request

This will execute a request with Harper using the operations API. The `request.body` should contain a standard Harper operation and must also include the `hdb_user` property that was in `request.body` provided in the callback.

#### requestWithoutAuthentication

Executes a request against Harper without any security checks around whether the inbound user is allowed to make this request. For security purposes, you should always take the following precautions when using this method:

- Properly handle user-submitted values, including url params. User-submitted values should only be used for `search_value` and for defining values in records. Special care should be taken to properly escape any values if user-submitted values are used for SQL.

### logger

This helper allows you to write directly to the log file, hdb.log. It's useful for debugging during development, although you may also use the console logger. There are 5 functions contained within logger, each of which pertains to a different **logging.level** configuration in your harper-config.yaml file.

- logger.trace('Starting the handler for /dogs')
- logger.debug('This should only fire once')
- logger.warn('This should never ever fire')
- logger.error('This did not go well')
- logger.fatal('This did not go very well at all')
