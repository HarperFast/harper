---
section: 'Security'
order: 20
---

### Intrinsics Are Sealed Instead of Frozen by Default

`applications.lockdown` has two new modes, `seal` and `seal-after-load`, and `seal-after-load` is the new default for new installs. Sealing stops code from adding or deleting properties on the JavaScript intrinsics (`Object`, `Array`, `Promise`, `Map`, and the other intrinsics listed under [What is locked](/reference/v5/components/module-loading#what-is-locked), plus `Function` and `Function.prototype`), which is what a prototype pollution payload such as `__proto__.isAdmin` needs. Unlike freezing, it leaves existing properties writable: an object can still shadow an inherited method (`arr.push = fn`), and code can still replace an existing prototype method. That also means a payload that overwrites an existing method, such as `__proto__.toString`, still succeeds; it mostly breaks behavior rather than granting access, and `freeze-after-load` remains the mode that blocks it. As under `freeze-after-load`, components and their dependencies can still extend the intrinsics while they load; once they have loaded, adding a property throws a `TypeError` in strict-mode code and is ignored in sloppy-mode code.

The seal modes also seal `Function.prototype`, which the freeze modes leave extensible. Code that adds a property to it after components load can therefore work under `freeze-after-load` but fail under `seal-after-load` (throwing in strict-mode code and silently doing nothing in sloppy-mode code).

The default changed because freezing is slow on Node.js. With frozen prototypes, V8 takes a slow path for every store into an array hole on that thread, Harper's own code included: in Harper's benchmark, msgpackr decoding inside a worker ran about four times slower than under `seal-after-load`. Sealing does not have that cost. `freeze-after-load` and `freeze` are unchanged; `none` and `ses` are also unchanged. See [Intrinsic Lockdown](/reference/v5/components/module-loading#intrinsic-lockdown) ([harper#3552](https://github.com/HarperFast/harper/pull/3552)).
