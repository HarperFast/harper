---
title: Reference
---

# Harper v5 Reference

Complete technical reference for Harper v5. Each section covers a core feature or subsystem — configuration options, APIs, and operational details.

For concept introductions, tutorials, and guides, see the [Learn](/learn) section.

## Sections

### Data & Application

| Section                                | Description                                                             |
| -------------------------------------- | ----------------------------------------------------------------------- |
| [Database](./database/overview.md)     | Schema system, storage, indexing, transactions, and the database JS API |
| [Resources](./resources/overview.md)   | Custom resource classes, the Resource API, and query optimization       |
| [Components](./components/overview.md) | Applications, extensions, the Plugin API, and the JS environment        |

### Access & Security

| Section                                        | Description                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| [REST](./rest/overview.md)                     | Auto-REST interface, querying, content types, headers, WebSockets, and SSE |
| [HTTP](./http/overview.md)                     | HTTP server configuration, TLS, and the `server` API                       |
| [Security](./security/overview.md)             | Authentication mechanisms, certificates, and CORS/SSL configuration        |
| [Users & Roles](./users-and-roles/overview.md) | RBAC, roles configuration, and user management operations                  |

### Setup & Operation

| Section                                        | Description                                                   |
| ---------------------------------------------- | ------------------------------------------------------------- |
| [CLI](./cli/overview.md)                       | All CLI commands, Operations API commands, and authentication |
| [Configuration](./configuration/overview.md)   | `harperdb-config.yaml` options and configuration operations   |
| [Operations API](./operations-api/overview.md) | Full index of all Operations API operations                   |

### Features

| Section                                                      | Description                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| [Logging](./logging/overview.md)                             | Log configuration, the `logger` API, and log management operations |
| [Analytics](./analytics/overview.md)                         | Resource and storage analytics, system tables                      |
| [MQTT](./mqtt/overview.md)                                   | MQTT broker configuration and usage                                |
| [Static Files](./static-files/overview.md)                   | Static file serving via the `static` plugin                        |
| [Environment Variables](./environment-variables/overview.md) | Environment variable loading via the `loadEnv` plugin              |
| [Replication](./replication/overview.md)                     | Native replication, clustering, and sharding                       |
| [GraphQL Querying](./graphql-querying/overview.md)           | Experimental GraphQL support                                       |
| [Studio](./studio/overview.md)                               | Local Studio UI configuration and access                           |
| [Fastify Routes](./fastify-routes/overview.md)               | Fastify route definitions (discouraged in favor of components)     |

### Legacy

| Section                                          | Description                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| [Harper Cloud](./legacy/cloud.md)                | Legacy Harper Cloud documentation — see Fabric for current cloud hosting |
| [Custom Functions](./legacy/custom-functions.md) | Deprecated predecessor to Components                                     |
