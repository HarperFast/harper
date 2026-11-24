---
section: 'Component Deploys'
---

### Application Status Heals, and Retires With the Application

`get_status` now reports each application under its own name in `componentStatus`, and an application loaded with nothing wrong reads `healthy`. A failed application no longer reports its failure until the process restarts: once a deploy or restart reloads components, an application whose load failed is loaded again and reports the new outcome, and an application removed from the components directory no longer appears. A component an application declares as a `package:` now reports under the application's name, such as `my-app.my-package`, where it used to report under the bare package name.
