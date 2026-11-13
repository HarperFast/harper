---
section: 'REST'
---

### Multipart Form Uploads

REST resources now decode `multipart/form-data` request bodies. A static handler receives the parts in order as `{ name, value }`, with each uploaded file streamed as a Blob while the upload is still arriving. A request handled by an inherited write, or a handler that calls `super.post(target, formData)`, receives a resolved object of the form's fields, with a repeated name as an array; authorization and the instance method see the same object ([harper#3126](https://github.com/HarperFast/harper/pull/3126)).
