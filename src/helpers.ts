import { castValue } from './schema-helpers'
import { writeDatabase } from './sqljs-handler'
import * as util from './util'

import * as knex from 'knex'

import { Trilogy } from '.'
import Model from './model'
import * as types from './types'

const HAS_TABLE_SUBSTRING = `from sqlite_master where type = 'table'`

export function parseResponse (
  contents: types.SqlJsResponse
): types.ObjectLiteral[] {
  if (!contents || !contents.length) return []

  const [{ columns, values }] = contents
  const results = []

  for (let i = 0; i < values.length; i++) {
    const line = {}

    for (let j = 0; j < columns.length; j++) {
      line[columns[j]] = values[i][j]
    }

    results.push(line)
  }

  return results
}

export function buildOrder (
  partial: knex.QueryBuilder,
  order: string | [string, string]
): knex.QueryBuilder {
  if (util.isString(order)) {
    if (order === 'random') {
      return partial.orderByRaw('RANDOM()')
    }
    return partial.orderBy(order)
  }

  if (Array.isArray(order)) {
    const { length } = order
    if (length === 1 || length === 2) {
      // typescript doesn't like this:
      // return partial.orderBy(...args)
      return partial.orderBy.apply(partial, order)
    }
  }

  return partial
}

export function buildWhere (
  partial: knex.QueryBuilder,
  where, // : types.WhereClause || types.WhereMultiple
  inner?: boolean
): knex.QueryBuilder {
  if (util.isObject(where)) {
    return partial.where(util.mapObj(where, castValue))
  }

  if (isWhereTuple(where)) {
    const i = where.length - 1
    const cast = where
    cast[i] = castValue(where[i])
    // typescript doesn't like this:
    // return partial.where(...cast)
    return partial.where.apply(partial, cast)
  }

  if (!inner && isWhereMultiple(where)) {
    return where.reduce<knex.QueryBuilder>((accumulator, clause) => {
      return buildWhere(accumulator, clause, true)
    }, partial)
  }

  // TODO: consider throwing an error for invalid where clauses
  return partial
}

export function isWhereTuple (where): where is types.WhereTuple {
  return (
    Array.isArray(where) &&
    (where.length === 2 || where.length === 3) &&
    typeof where[0] === 'string'
  )
}

export function isWhereMultiple (where): where is types.WhereMultiple {
  return (
    Array.isArray(where) &&
    where.every(item => isWhereTuple(item) || util.isObject(item))
  )
}

export function isValidWhere (where): where is types.WhereClause {
  return (
    isWhereTuple(where) ||
    util.isObject(where) ||
    isWhereMultiple(where)
  )
}

export async function runQuery (
  instance: Trilogy,
  query: types.Query,
  needResponse?: boolean
): Promise<any> {
  const asString = query.toString()
  const action = getQueryAction(asString)
  if (util.isFunction(instance.verbose)) {
    instance.verbose(asString)
  }

  if (instance.isNative) {
    if (needResponse) return query

    // tslint:disable-next-line:await-promise
    const res = await query
    if (util.isNumber(res)) return res
    return res ? res.length : 0
  }

  const db = await instance.pool.acquire()
  let response

  if (needResponse) {
    response = parseResponse(db.exec(asString))
    if (asString.toLowerCase().includes(HAS_TABLE_SUBSTRING)) {
      response = !!response.length
    }
  } else {
    db.run(asString)

    if (['insert', 'update', 'delete'].includes(action)) {
      response = db.getRowsModified()
    }
  }

  writeDatabase(instance, db)
  instance.pool.release(db)
  return response
}

export async function findLastObject (
  model: Model,
  object: types.ObjectLiteral
): Promise<types.ObjectLiteral | void> {
  const { key, hasIncrements } = findKey(model.schema)

  if (!key && !hasIncrements) {
    // if there is no unique identifier like a primary key, we try to use
    // sqlite's `last_insert_rowid()` function to find the last object
    // https://www.sqlite.org/c3ref/last_insert_rowid.html

    const idQuery = model.ctx.knex.raw('select last_insert_rowid() as rowid')
    const [{ rowid }] = await runQuery(model.ctx, idQuery, true)
    if (typeof rowid !== 'number') return undefined

    const query = model.ctx.knex(model.name).first().where({ rowid })
    return runQuery(model.ctx, query, true)
  }

  const query = hasIncrements
    ? model.ctx.knex('sqlite_sequence').first('seq').where({ name: model.name })
    : model.ctx.knex(model.name).first().where({ [key]: object[key] })

  const res = await runQuery(model.ctx, query, true)
  const out = model.ctx.isNative ? res : res[0]
  return hasIncrements ? model.findOne({ [key]: out.seq }) : out
}

function findKey (schema: types.Schema) {
  let key = ''
  let hasIncrements = false

  const keys = Object.keys(schema)
  for (const name of keys) {
    const props = schema[name]
    if (props === 'increments' || props.type === 'increments') {
      key = name
      hasIncrements = true
      break
    } else if (props.primary || props.unique) {
      key = name
    }
  }

  return { key, hasIncrements }
}

function getQueryAction (str: string): string {
  return str.split(' ', 1)[0].toLowerCase()
}
