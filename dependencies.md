# Dependencies

This page describes the dependencies of HarperDB, the reasons for their inclusion, and the steps and considerations for adding new third party package or dependency to HarperDB. This is intended to ensure that packages are added correctly with appropriate review and consideration.

A significant amount of work goes into minimizing the complexity and interdependencies of the HarperDB. Maintaining a minimum of dependencies requires discipline, and consequently a thorough review should be performed before considering the addition of any new packages or components of any substantial size. Addition of packages is similar to the economic concept of "negative externality", like carbon emissions, where a package may seem expedient for solving an immediate issue, but each package has a subtle negative impacts on the rest of the application, and the cumulative effect of numerous third-party packages gradually leads to increases in memory consumption, slowed performance, application complexity, dependency management, increased security vulnerabilities, and complex interactions that together slow down development, increase the difficulty of code maintenance, and reduce application usability.

Every addition of a dependency should be accompanied by a review of the performance, security, and complexity implications. Also, with every dependency, we should expect and plan for its eventual removal, whether that be due to issues that are found with package, need for improved performance, or neglect of the package maintenance. Every review should include a plan for how the dependency could eventually be removed with minimal impact.

Note that adding development dependencies (for testing, building, or other dev activities), should still involve some consideration, but does not require nearly the level of review, since it won't involve loading code in production.

In reviewing the third party package or dependency, the following questions should be addressed, and the proposed addition should be reviewed and vetted by the engineering team. The dependency and answers to questions can be appended to this document so all dependency justifications can be found here, as well as removal plans, and they can be reviewed together with code in pull requests.

- What is the size of the package, including all transitive dependencies (that aren't already included)?
- Can some or all be deferred?
- What is the security track record of this package?
- Does this have transitive dependencies that also add overhead, complexity, and security vulnerability?
- What is the memory cost? How much additional memory is required?
- What is the environment interaction? Does this alter any globals or constructs in the environment? Does this load any polyfills that alter existing objects?
- Is there any overlap in functionality with an existing packages? In what ways do existing packages fail to provide, or can't be extended to provide, the necessary functionality?
- Does this require binary compilation? (This has added some extra challenges)
- How would we eventually remove this package?

Generally, dependencies are added by simply adding them to the dependencies list in package.json. If the dependency is not necessary for the actual execution of the application (testing or building), it can be placed in devDependencies, or in optionalDependencies (we have done that with packages with binary compilations).

## graphql

- Need for usage: For supporting GraphQL schemas and queries.
- Size/memory cost: About 500KB
- Security: No reported vulnerabilities (impressive for a popular package) https://security.snyk.io/package/npm/graphql
- Overlap: None
- Can be deferred: Yes, this only loaded when a GraphQL schema is loaded.
- Binary compilation: No
- Eventual removal: It may be feasible to implement GraphQL parsing separately

## mqtt-packet

- Need for usage: We need to support MQTT
- Size/memory-cost: a couple hundred kilobytes with transitive dependencies
- Security: Had a vulnerability several major versions ago: https://security.snyk.io/package/npm/mqtt-packet
- Environment interaction: None
- Overlap: None
- Binary compilation: No
- Eventual removal: MQTT is a very well documented, and relatively simple specification, we can definitely implement this ourselves.

## ses

- Need for usage: Provides secure sand-boxing JavaScript environment
- Security: Developed by security experts with bounties for security issues
- Environment interaction: This creates a `lockdown` global function for deep freezing objects.
- Can be deferred: Yes, this only loaded when secure sand-boxing is enabled and modules are loaded.
- Eventual removal: Secure EcmaScript consists of a set of functionality that is all proposed as additions to EcmaScript itself, and the developers are probably the most influential people in TC-39.

## @endo/static-module-record

- Need for usage: Provides the safety verification of modules for loading into a secure JavaScript environment
  Environment interaction: None
- Can be deferred: Yes, this only loaded when secure sand-boxing is enabled and modules are loaded.
- Eventual removal: Same as above

## ws

- Need for usage: We need to support WebSockets
- Security: Had vulnerabilities, but quickly addressed: https://security.snyk.io/package/npm/ws
- Environment interaction: None
- Overlap: None
- Binary compilation: Has optional dependencies with binary compilation for acceleration
- Eventual removal: Because this is a standard-based API, this will hopefully be rolled into a core JavaScript runtime feature at some point (and already is in Deno).

## json-bigint (forked as json-bigint-fixes)

- Need for usage: We need to support parsing and serializing ("stringify") JSON with big integers.
- Size/memory cost: About 30KB
- Security: Prototype pollution vulnerability was addressed: https://security.snyk.io/package/npm/json-bigint
  Unfortuneately this project has not been published for three years, although it does have commits in the last two years. Consequently, we have forked and published the latest, with the fixes it provides.
- Overlap: None
- Can be deferred: Too small to matter
- Binary compilation: No
- Eventual removal: This code could be maintained within our codebase, if necessary, as it is not very large.

## segfault-handler

- Need for usage: Provides a way to log segfaults in native code
- Size/memory cost: 10KB
- Security: No reported vulnerabilities
- Binary compilation: Yes (but included as an optional dependency)
- Eventual removal: This is a very small package, and it is not necessary, just adds debugging information

## tar-fs

- Need for usage: Used by package component to pack component project into tarball and by deploy component to extract tarball into component directory.
- Size/memory cost: Approximately 13KB
- Security: One medium level where an attacker can overwrite files on the system when extracting a tarball containing a hardlink to a file that already exists, this has since been fixed.
- Overlap: None
- Can be deferred: Potentially, we could load it on-demand
- Eventual removal: We could write our own code that read/writes multiple files from/to a tar file

## gunzip-maybe

- Need for usage: Used by deploy component
- Size/memory cost: Approximately 320B
- Security: None
- Overlap: None
- Can be deferred: Potentially, we could load it on-demand
- Eventual removal: We could write code to read the first bytes to determine what type of file it is and choose whether to gunzip it or not

## argon2id

- Need for usage: An optional extra secure password hashing algorithm used for hdb users
- Size/memory cost: 866KB
- Security: None
- Overlap: None
- Can be deferred: Potentially, we could load it on-demand
- Eventual removal: Yes, once node crypto adds native support for argon2

## hdd-space
- Need for usage: Used to check for sufficient disk space on Node v16. Runs `df`. Should _only_ run on Node v16.
- Size: 387KB
- Security: No known issues.
- Eventual removal: As soon as we can drop Node v16 support, we should *immediately* remove this dependency. It is not needed on Node v18+.

## chokidar
- Need for usage: Reliable file watching. This is the industry standard file watcher and deals with the many edge cases that node.js's watch (file replacement and changing inode for example) and watchFile (nothing but a terrible poller on a timer) don't handle well.
- 153KB
- Security: No known issues.
- Eventual removal: This is a very well maintained package and is the industry standard for file watching. We could remove with very careful usage of `watch`, but would probably require a lot of testing and edge case handling.