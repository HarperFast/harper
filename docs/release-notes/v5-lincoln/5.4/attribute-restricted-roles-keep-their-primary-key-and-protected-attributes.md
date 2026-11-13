---
section: 'Security'
---

### Attribute-Restricted Roles Keep Their Primary Key and Protected Attributes

For a role with `attribute_permissions`, REST, GraphQL and MQTT now grant an unlisted primary key the access the role's listed attributes give, unless the role explicitly denies it. A full `PUT` or retained MQTT publish from such a role is staged as a patch: attributes the role cannot update keep their stored values, and writable attributes the body omits are cleared. Before, the primary key was left out, and a full replacement erased every attribute the role could not update ([harper#3297](https://github.com/HarperFast/harper/pull/3297)).
