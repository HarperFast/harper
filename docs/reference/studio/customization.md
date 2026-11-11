---
title: Customizing Studio
sidebar_position: 20
sidebar_label: 'Customization'
---

# Customizing Studio

<VersionBadge version="v5.4.0" />

An application or a plugin can add pages to Studio and suggest how Studio shows its tabs, and a cluster can hide or tuck away Studio's tabs and choose the page Studio opens on. Studio reads all of it through [`get_studio_configuration`](#get_studio_configuration).

## Component Pages

A component declares its pages under `studio.pages` in its `config.yaml`:

```yaml
studio:
  pages:
    - id: redirects
      name: Redirects
      icon: signpost
      placement: tab
      description: HTTP redirects served before your app runs.
      access:
        role: super_user
        tables:
          - { database: data, table: Redirect, actions: [read, update] }
      content:
        kind: sections
        sections:
          - type: table
            database: data
            table: Redirect
            primaryKey: id
```

- `id` - Required. Up to 64 lowercase letters, digits and `-`, unique within the component. Studio names the page `<component>.<id>`, for example `harper-redirects.redirects`.
- `name` - Required. The page's title.
- `placement` - Required. `tab` for a top Studio tab, `config` for an entry in the Config page's menu.
- `icon` - A [Lucide](https://lucide.dev/icons) icon name.
- `description` - Text Studio shows with the page.
- `access` - Who Studio shows the page to: a `role`, the `tables` and `operations` the viewer needs, and `optional` ones that only some controls need. Studio checks it against the viewer's role. It is not a server permission: the viewer's own permissions still decide what each request may do.
- `content` - What the page shows, which Studio renders.
- `navigation` - How Studio shows the page by default: `visible`, `tucked` or `hidden`. The `studio.navigation` of a component that loads this one, or the cluster settings, override it (see [Navigation from Components](#navigation-from-components)).

Harper returns `access` and `content` as written, without validating them. It drops any other key, and does not return `navigation` on the page.

`get_studio_configuration` returns these declarations to every signed-in user, so they must hold no secrets or option values.

A page with a missing or invalid `id`, `name` or `placement` is left out, and Harper logs a warning naming the field. The component still loads. A config file that Harper cannot parse adds no pages; a duplicate key is the one YAML error it reads past. A page whose key `<component>.<id>` is longer than 128 characters is left out, because navigation could not name it.

## Plugin Pages

A plugin declares pages in its own `config.yaml`, the same way. Harper reads them for each application whose config names the plugin in a `package` entry, finding it where the application loader does: in the application's `node_modules`, then in each parent directory's. It reads what is installed and declared, not whether the plugin loaded, but it skips a plugin the loader skips by configuration: one marked `loadComponent: dev-only` outside development mode, one not installed, and every plugin in safe mode.

A plugin's page belongs to each application that loads it. Its component is `<application>.<key>`, where `<key>` is the application's config entry for the plugin, so the redirector plugin loaded by `solution` as `'@harperfast/redirector'` gives the page key `solution.@harperfast/redirector.redirects`. A plugin loaded by another plugin chains the keys: `<application>.<key>.<subKey>.<id>`. Two applications that load one plugin each get its pages.

If two different components produce the same page key, for example a plugin keyed `a.b` and a plugin `b` loaded by a plugin `a`, Harper leaves that page out of both and logs a warning. A plugin key that is not a usable name (one with a `..` segment, for example) adds no pages.

## Navigation from Components

An application or plugin can set `studio.navigation` in its own `config.yaml`. A bare key is a built-in tab. A dotted key names a page of a plugin this component loads, relative to the component itself, so a component does not need to know the name it is deployed under:

```yaml
# the solution application's config.yaml
'@harperfast/redirector':
  package: '@harperfast/redirector'
studio:
  navigation:
    applications: hidden
    '@harperfast/redirector.redirects': tucked # solution.@harperfast/redirector.redirects
```

For one tab or page:

- The cluster settings beat any component.
- An application beats the plugins it loads, and a plugin beats the plugins it loads.
- Between peers, such as two applications, the most visible state wins: `visible`, then `tucked`, then `hidden`.
- A page's own `navigation` applies only where nothing else names the page.

`studio.landing` is read from the root config only.

## Cluster Settings

Two [`set_configuration`](../configuration/operations.md#set-configuration) parameters set how Studio presents itself on a node:

- `studio_navigation` - A map from a tab key to `visible`, `tucked` or `hidden`. A key is a built-in tab's key or a page's full `<component>.<id>`, up to 128 characters. The map replaces the whole previous one; `{}` or `null` clears it.
- `studio_landing` - The tab key or `<component>.<id>` Studio opens on. `null` clears it.

```json
{
	"operation": "set_configuration",
	"studio_navigation": { "applications": "hidden", "logs": "tucked", "harper-redirects.redirects": "tucked" },
	"studio_landing": "harper-redirects.redirects",
	"replicated": true
}
```

A change takes effect on the next `get_studio_configuration` call, with no restart. An invalid value fails with a 400, including a page key written as a nested map (`{ "harper-redirects": { "redirects": "tucked" } }`) rather than `harper-redirects.redirects`. A write that `HARPER_CONFIG` or `HARPER_SET_CONFIG` would revert on the next start fails with a 409.

Without `"replicated": true`, the settings change only the node that receives the call. A node added later needs them set too.

## `get_studio_configuration`

Returns the cluster settings and every application's and plugin's pages, and nothing else from any configuration. It takes no parameters.

- `navigation` - The navigation Studio shows: the cluster settings merged with what applications, plugins and pages set. Present when any of them sets a key.
- `rootNavigation` - The cluster settings alone. Present whenever `navigation` is, as `{}` when the cluster sets none.
- `landing` - The cluster's landing page, when set.
- `pages` - Every page, with its `component`, its `application`, and for a plugin's page `plugins`: the plugin keys from the application down.

```json
{ "operation": "get_studio_configuration" }
```

```json
{
	"navigation": { "applications": "hidden", "logs": "tucked", "harper-redirects.redirects": "tucked" },
	"rootNavigation": { "applications": "hidden", "logs": "tucked", "harper-redirects.redirects": "tucked" },
	"landing": "harper-redirects.redirects",
	"pages": [
		{
			"component": "harper-redirects",
			"application": "harper-redirects",
			"id": "redirects",
			"name": "Redirects",
			"icon": "signpost",
			"placement": "tab",
			"description": "HTTP redirects served before your app runs.",
			"access": {
				"role": "super_user",
				"tables": [{ "database": "data", "table": "Redirect", "actions": ["read", "update"] }]
			},
			"content": {
				"kind": "sections",
				"sections": [{ "type": "table", "database": "data", "table": "Redirect", "primaryKey": "id" }]
			}
		}
	]
}
```

Every signed-in user can call it. A role whose `operations` list limits it to named operations must list `get_studio_configuration`, or a group that includes it: `read_only`, `standard_user` or `admin_read` ([permission groups](../users-and-roles/overview.md#operation-permissions)).

Each call reads the configuration files from disk, so a deploy, drop or `set_configuration` shows on the next call.

## The `studio` Component Name

The root configuration's `studio` entry holds these settings, so `studio` is a reserved component name, like `sql`. A deploy named `studio` fails with a 400. An application deployed as `studio` before 5.4 still loads and can be dropped; dropping it leaves the Studio settings in place. To redeploy it, use another name.
