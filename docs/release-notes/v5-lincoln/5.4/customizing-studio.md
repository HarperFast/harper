---
section: 'Studio'
---

### Component Pages and Cluster Settings for Studio

A component can add pages to Studio by declaring them under `studio.pages` in its `config.yaml`. A cluster can hide or tuck away Studio's tabs and choose the page Studio opens on, with the new `set_configuration` parameters `studio_navigation` and `studio_landing`. Studio reads both through the new `get_studio_configuration` operation, which every signed-in user can call. A role limited to named `operations` needs it listed, or one of the `read_only`, `standard_user` or `admin_read` groups, which now include it. See [Customizing Studio](/reference/v5/studio/customization).

`studio` is now a reserved component name, like `sql`, because the root configuration's `studio` entry holds these settings. A deploy named `studio` now fails with a 400. An application already deployed as `studio` still loads and can be dropped, which leaves the settings in place; to redeploy it, use another name. ([#3656](https://github.com/HarperFast/harper/pull/3656))
