---
title: Customizing Studio
sidebar_position: 20
sidebar_label: 'Customization'
---

# Customizing Studio

<VersionBadge version="v5.4.0" />

A component can add pages to Studio, and a cluster can hide or tuck away Studio's tabs and choose the page Studio opens on. Studio reads both through [`get_studio_configuration`](#get_studio_configuration).

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

- `id` - Required. Lowercase letters, digits and `-`, unique within the component. Studio names the page `<component>.<id>`, for example `harper-redirects.redirects`.
- `name` - Required. The page's title.
- `placement` - Required. `tab` for a top Studio tab, `config` for an entry in the Config page's menu.
- `icon` - A [Lucide](https://lucide.dev/icons) icon name.
- `description` - Text Studio shows with the page.
- `access` - Who Studio shows the page to: a `role`, the `tables` and `operations` the viewer needs, and `optional` ones that only some controls need. Studio checks it against the viewer's role. It is not a server permission: the viewer's own permissions still decide what each request may do.
- `content` - What the page shows, which Studio renders.

Harper returns `access` and `content` as written, without validating them. It drops any other key.

`get_studio_configuration` returns these declarations to every signed-in user, so they must hold no secrets or option values.

A page with a missing or invalid `id`, `name` or `placement` is left out, and Harper logs a warning naming the field. The component still loads. A config file that Harper cannot parse adds no pages; a duplicate key is the one YAML error it reads past.

## Cluster Settings

Two [`set_configuration`](../configuration/operations.md#set-configuration) parameters set how Studio presents itself on a node:

- `studio_navigation` - A map from a tab key to `visible`, `tucked` or `hidden`. A key is a built-in tab's key or a component page's `<component>.<id>`. The map replaces the whole previous one; `{}` or `null` clears it.
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

Returns the cluster settings and every component's pages, and nothing else from any configuration. It takes no parameters.

```json
{ "operation": "get_studio_configuration" }
```

```json
{
	"navigation": { "applications": "hidden", "logs": "tucked", "harper-redirects.redirects": "tucked" },
	"landing": "harper-redirects.redirects",
	"pages": [
		{
			"component": "harper-redirects",
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
