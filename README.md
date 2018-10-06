# Bookshelf Cascade Soft Delete

This is a plugin to be used with Bookshelf. It's the combination of two existing plugins, [node-bookshelf-soft-delete](https://github.com/lanetix/node-bookshelf-soft-delete) and [bookshelf-cascade-delete](https://github.com/seegno/bookshelf-cascade-delete), as well as custom code to accomplish the cacade soft deletions. 

# Installation
Intall the package via npm: 
```
$ npm install --save bookshelf-cascade-soft-delete
```

#Usage
To be honest, nothing changes from the documentation of [node-bookshelf-soft-delete](https://github.com/lanetix/node-bookshelf-soft-delete) and [bookshelf-cascade-delete](https://github.com/seegno/bookshelf-cascade-delete). You just need the combined functionality. 

## Examples
```
const bookshelf = require('../config/bookshelf');

const CompanyAddress = require('./CompanyAddress');
const Crew = require('./Crew');

bookshelf.plugin('registry');
bookshelf.plugin(require('../config/custom-soft-cascade-delete'));

module.exports = bookshelf.model('Company', {
    tableName: 'companies',
    defaults: {
        name: '',
    },
    company_address: function() {
        return this.hasOne(CompanyAddress);
    },
    crews: function() {
        return this.hasMany(Crew);
    },
    soft: true
}, {
    dependents: ['company_address', 'crews', 'company_employee_roles'],
});
```

Declaring soft: true will make any instances of the model will add 'deleted_at' and 'restored_at' fields to the table, by default. The names of those fields can be customized by the following:

```
soft: ['deletionDate', 'restorationDate']
```

The dependents field decalres which child models will be cascade deleted. If you want them to be soft deleted, you need to declare the soft field on those models.
