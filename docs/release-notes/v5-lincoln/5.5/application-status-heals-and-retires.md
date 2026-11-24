---
section: 'Component Deploys'
---

### Application Status Heals, and Retires With the Application

`get_status` now reports each application under its own name in `componentStatus`, and an application loaded with nothing wrong reads `healthy`. A failed application no longer reports its failure until the process restarts: once a deploy or restart reloads components, an application in the components directory whose load failed is loaded again and reports the new outcome, and an application removed from that directory no longer appears. An application installed through a root-config `package:` entry, or on an instance with `threads.count: 0`, still reports a failure until the next restart. A component an application declares as a `package:` now reports under the application's name, such as `my-app.my-package`, where it used to report under the bare package name.
