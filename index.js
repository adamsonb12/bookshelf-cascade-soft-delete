const { mapSeries } = require('bluebird');
const { flattenDeep, reduce } = require('lodash');

function shouldDisable(opts) {
    return opts && opts.hasOwnProperty('softDelete') && !opts.softDelete;
}

function addDeletionCheck(softFields) {
    var deletedAtField = softFields[0];
    var restoredAtField = softFields[1];

    /*eslint-disable no-underscore-dangle*/
    if (this._knex) {
        var table = this._knex._single.table;
        /*eslint-enable no-underscore-dangle*/

        deletedAtField = table + '.' + softFields[0];
        restoredAtField = table + '.' + softFields[1];
    }

    this.query(function(qb) {
        qb.where(function() {
            var query = this.whereNull(deletedAtField);
            if (softFields[1]) {
                query.orWhereNotNull(restoredAtField);
            }
        });
    });
}

function setSoftDeleteOptions(soft) {
    if (Array.isArray(soft)) {
        this.softFields = soft;
        this.softActivated = true;
    } else if (soft === true) {
        this.softFields = ['deleted_at', 'restored_at'];
        this.softActivated = true;
    } else {
        this.softFields = false;
        this.softActivated = null;
    }
}

module.exports = function(Bookshelf) {
    const mProto = Bookshelf.Model.prototype;
    const cProto = Bookshelf.Collection.prototype;
    const knex = Bookshelf.knex;
    const client = knex.client.config.client;
    const quoteColumns = client === 'postgres' || client === 'postgresql' || client === 'pg';

    function dependencyMap(skipDependents = false) {
        if (skipDependents || !this.dependents) {
            return;
        }

        return reduce(
            this.dependents,
            (result, dependent) => {
                const { relatedData } = this.prototype[dependent]();
                const skipDependents = relatedData.type === 'belongsToMany';

                return [
                    ...result,
                    {
                        dependents: dependencyMap.call(relatedData.target, skipDependents),
                        key: relatedData.key('foreignKey'),
                        model: relatedData.target,
                        skipDependents,
                        tableName: skipDependents ? relatedData.joinTable() : relatedData.target.prototype.tableName,
                    },
                ];
            },
            []
        );
    }

    function recursiveDeletes(parent) {
        const parentValue =
            typeof parent === 'number' || typeof parent === 'string' ? `'${parent}'` : parent.toString();
        const dependencies = dependencyMap.call(this);

        // Build delete queries for each dependent.
        return reduce(
            dependencies,
            (result, options) => {
                const { model, tableName, key, skipDependents } = options;
                const whereClause = `${quoteColumns ? `"${key}"` : key} IN (${parentValue})`;
                const { soft } = model.prototype;
                let softFields;
                let softActivated;
                if (Array.isArray(soft)) {
                    softFields = soft;
                    softActivated = true;
                } else if (soft === true) {
                    softFields = ['deleted_at', 'restored_at'];
                    softActivated = true;
                } else {
                    softFields = false;
                    softActivated = null;
                }
                if (soft && softActivated) {
                    const deleted_at = softFields[0];
                    const restored_at = softFields[1];
                    const fields = {};
                    fields[deleted_at] = new Date();
                    fields[restored_at] = null;
                    return [
                        ...result,
                        transaction =>
                            transaction(tableName)
                                .update(fields)
                                .whereRaw(whereClause),
                        skipDependents
                            ? []
                            : recursiveDeletes.call(
                                model,
                                knex(tableName)
                                    .column(model.prototype.idAttribute)
                                    .whereRaw(whereClause)
                            ),
                    ];
                } else {
                    return [
                        ...result,
                        transaction =>
                            transaction(tableName)
                                .del()
                                .whereRaw(whereClause),
                        skipDependents
                            ? []
                            : recursiveDeletes.call(
                                model,
                                knex(tableName)
                                    .column(model.prototype.idAttribute)
                                    .whereRaw(whereClause)
                            ),
                    ];
                }
            },
            []
        );
    }

    async function cascadeDelete(transacting, options) {
        const model = this;
        const id = this.get(this.idAttribute) || this._knex.column(this.idAttribute);
        const queries = recursiveDeletes.call(this.constructor, id, options);
        return mapSeries(flattenDeep(queries).reverse(), query => query(transacting)).then(() =>
            model.softDestroy.call(this, {
                ...options,
                transacting,
            })
        );
    }

    Bookshelf.Model = Bookshelf.Model.extend({
        initialize: function() {
            setSoftDeleteOptions.call(this, this.soft);
            return mProto.initialize.apply(this, arguments);
        },

        fetch: function(opts) {
            if (this.softActivated && !shouldDisable(opts)) {
                addDeletionCheck.call(this, this.softFields);
            }
            return mProto.fetch.apply(this, arguments);
        },

        restore: function(opts) {
            opts = opts || {};

            if (this.softActivated) {
                if (this.get(this.softFields[0])) {
                    if (this.softFields[1]) {
                        // Set restored_at
                        this.set(this.softFields[1], new Date());
                    } else {
                        // If restored_at does not exist, remove the deleted_at
                        this.set(this.softFields[0], null);
                    }
                    return this.save(null, opts);
                }
            } else {
                throw new TypeError('restore can not be used if the model does not ' + 'have soft delete enabled');
            }
        },

        softDestroy: function(opts) {
            opts = opts || {};

            if (this.softActivated && !shouldDisable(opts)) {
                const model = this;
                const softFields = model.softFields;
                return model
                    .triggerThen('destroying', model, opts)
                    .then(function() {
                        if (softFields[1]) {
                            model.set(softFields[1], null);
                        }
                        model.set(softFields[0], new Date());
                        return model.save(null, opts);
                    })
                    .then(function() {
                        return model.triggerThen('destroyed', model, undefined, opts);
                    });
            } else {
                return mProto.destroy.apply(this, arguments);
            }
        },

        destroy: function(options) {
            options = options || {};
            const model = this;
            if (options.cascadeDelete === false) {
                return model.destroy.call(this, options);
            }
            if (options.transacting) {
                return cascadeDelete.call(this, options.transacting, options);
            }
            return Bookshelf.knex.transaction(transacting => cascadeDelete.call(this, transacting, options));
        },
    });

    Bookshelf.Collection = Bookshelf.Collection.extend({
        fetch: function(opts) {
            var modelOpts = {};
            setSoftDeleteOptions.call(modelOpts, this.model.prototype.soft);

            if (modelOpts.softActivated && !shouldDisable(opts)) {
                addDeletionCheck.call(this, modelOpts.softFields);
            }
            return cProto.fetch.apply(this, arguments);
        },

        count: function(field, opts) {
            opts = opts || field;

            var modelOpts = {};
            setSoftDeleteOptions.call(modelOpts, this.model.prototype.soft);

            if (modelOpts.softActivated && !shouldDisable(opts)) {
                addDeletionCheck.call(this, modelOpts.softFields);
            }

            return cProto.count.apply(this, arguments);
        },
    });
};
