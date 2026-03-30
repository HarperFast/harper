---
title: Components
---

<!-- Source: versioned_docs/version-4.7/reference/components/index.md (primary) -->
<!-- Source: versioned_docs/version-4.7/developers/applications/index.md (terminology and evolution context) -->
<!-- Source: release-notes/v4-tucker/4.2.0.md (component architecture introduction) -->
<!-- Source: release-notes/v4-tucker/4.6.0.md (plugin API introduction) -->
<!-- Source: release-notes/v4-tucker/4.7.0.md (component status monitoring) -->

# Components

**Components** are the high-level concept for modules that extend the Harper core platform with additional functionality. Components encapsulate both applications and extensions.

> Harper is actively working to disambiguate component terminology. When you see "component" in the Operations API or CLI, it generally refers to an application. Documentation does its best to clarify which classification of component is meant wherever possible.

## Concepts

### Applications

Added in: v4.2.0

**Applications** implement specific user-facing features or functionality. Applications are built on top of extensions and represent the end product that users interact with. For example, a Next.js application serving a web interface or an Apollo GraphQL server providing a GraphQL API are both applications. Also, a collection of Harper Schemas and/or custom Resources is also an application.

### Extensions

Added in: v4.2.0

**Extensions** are the building blocks of the Harper component system. Applications depend on extensions to provide the functionality they implement. For example, the built-in `graphqlSchema` extension enables applications to define databases and tables using GraphQL schemas. The `@harperdb/nextjs` and `@harperdb/apollo` extensions provide building blocks for Next.js and Apollo applications respectively.

Extensions can also depend on other extensions. For example, `@harperdb/apollo` depends on the built-in `graphqlSchema` extension to create a cache table for Apollo queries.

### Plugins (Experimental)

Added in: v4.6.0 (experimental)

**Plugins** are a new iteration of the extension system introduced in v4.6. They are simultaneously a simplification and extensibility upgrade over extensions. Instead of defining multiple methods (`start` vs `startOnMainThread`, `handleFile` vs `setupFile`, `handleDirectory` vs `setupDirectory`), plugins only export a single `handleApplication` method.

Plugins are **experimental**. In time extensions will be deprecated in favor of plugins, but both are currently supported. See the [Plugin API](./plugin-api.md) reference for complete documentation.

### Built-In vs. Custom Components

**Built-in** components are included with Harper by default and referenced directly by name. Examples include `graphqlSchema`, `rest`, `jsResource`, `static`, and `loadEnv`.

**Custom** components use external references—npm packages, GitHub repositories, or local directories—and are typically included as `package.json` dependencies.

Harper does not currently include built-in applications. All applications are custom.

## Architecture

The relationship between applications, extensions, and Harper core:

```
Applications
 ├── Next.js App        → @harperdb/nextjs extension
 ├── Apollo App         → @harperdb/apollo extension
 └── Custom Resource    → jsResource + graphqlSchema + rest extensions

Extensions
 ├── Custom: @harperdb/nextjs, @harperdb/apollo, @harperdb/astro
 └── Built-In: graphqlSchema, jsResource, rest, static, loadEnv, ...

Core
 └── database, file-system, networking
```

## Configuration

Harper components are configured with a `config.yaml` file in the root of the component module directory. This file is how a component configures other components it depends on. Each entry starts with a component name, with configuration values indented below:

```yaml
componentName:
  option-1: value
  option-2: value
```

### Default Configuration

Components without a `config.yaml` get this default configuration automatically:

```yaml
rest: true
graphqlSchema:
  files: '*.graphql'
roles:
  files: 'roles.yaml'
jsResource:
  files: 'resources.js'
fastifyRoutes:
  files: 'routes/*.js'
  urlPath: '.'
static:
  files: 'web/**'
```

If a `config.yaml` is provided, it **replaces** the default config entirely (no merging).

### Custom Component Configuration

Any custom component must be configured with a `package` option for Harper to load it. The component name must match a `package.json` dependency:

```json
{
	"dependencies": {
		"@harperdb/nextjs": "1.0.0"
	}
}
```

```yaml
'@harperdb/nextjs':
  package: '@harperdb/nextjs'
  files: './'
```

The `package` value supports any valid npm dependency specifier: npm packages, GitHub repos, tarballs, local paths, and URLs. This is because Harper generates a `package.json` from component configurations and uses `npm install` to resolve them.

### Extension and Plugin Configuration

Extensions require an `extensionModule` option pointing to the extension source. Plugins require a `pluginModule` option. See [Extension API](./extension-api.md) and [Plugin API](./plugin-api.md) for details.

## Built-In Extensions Reference

| Name                                              | Description                                       |
| ------------------------------------------------- | ------------------------------------------------- |
| [`dataLoader`](../database/data-loader.md)        | Load data from JSON/YAML files into Harper tables |
| [`fastifyRoutes`](../fastify-routes/overview.md)  | Define custom endpoints with Fastify              |
| [`graphql`](../graphql-querying/overview.md)      | Enable GraphQL querying (experimental)            |
| [`graphqlSchema`](../database/schema.md)          | Define table schemas with GraphQL syntax          |
| [`jsResource`](../resources/overview.md)          | Define custom JavaScript-based resources          |
| [`loadEnv`](../environment-variables/overview.md) | Load environment variables from `.env` files      |
| [`rest`](../rest/overview.md)                     | Enable automatic REST endpoint generation         |
| [`roles`](../users-and-roles/overview.md)         | Define role-based access control from YAML files  |
| [`static`](../static-files/overview.md)           | Serve static files via HTTP                       |

## Known Custom Components

### Applications

- [`@harperdb/status-check`](https://github.com/HarperDB/status-check)
- [`@harperdb/prometheus-exporter`](https://github.com/HarperDB/prometheus-exporter)
- [`@harperdb/acl-connect`](https://github.com/HarperDB/acl-connect)

### Extensions

- [`@harperdb/nextjs`](https://github.com/HarperDB/nextjs)
- [`@harperdb/apollo`](https://github.com/HarperDB/apollo)
- [`@harperdb/astro`](https://github.com/HarperDB/astro)

## Component Status Monitoring

Added in: v4.7.0

Harper collects status from each component at load time and tracks any registered status change notifications. This provides visibility into the health and state of running components.

## Evolution History

- **v4.1.0** — Custom functions with worker threads (predecessor to components)
- **v4.2.0** — Component architecture introduced; Resource API, REST interface, MQTT, WebSockets, SSE, configurable schemas
- **v4.3.0** — Component configuration improvements
- **v4.6.0** — New extension API with dynamic reloading; Plugin API introduced (experimental)
- **v4.7.0** — Component status monitoring; further plugin API improvements

## See Also

- [Applications](./applications.md) — Managing and deploying applications
- [Extension API](./extension-api.md) — Building custom extensions
- [Plugin API](./plugin-api.md) — Building plugins (experimental, recommended for new extensions)
- [Resource API](../resources/resource-api.md) — Resource class interface
- [Database Schema](../database/schema.md) — Defining schemas with graphqlSchema
