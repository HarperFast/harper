---
section: 'REST'
---

### Condition Values Convert With the Compared Attribute's Type

A REST condition value is converted with the type of the value it is compared with in three more places, so these numeric queries no longer return nothing or too much: the second leg of a chained range (`?price=ge=10&=le=30`), an array attribute's elements (`?sizes=ge=300` on `[Int]`), and relationship paths (`?products.price=ge=30`, `?products[price=ge=30]`), converted with the related table's type at every hop. `contains`, `starts_with` and `ends_with` on an array keep text. Explicit `number:` prefixes and strict `===` are unchanged ([harper#3952](https://github.com/HarperFast/harper/pull/3952)).
