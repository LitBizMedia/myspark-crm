// lib/db.js
// 
// Direct pg client wrapper for RDS, replacing the Supabase REST API fetch pattern.
// 
// Connection: pg pool with IAM auth via RDS Proxy.
// Token cached for 14 minutes (tokens last 15).
//
// Three ways to use:
//
// 1. Raw query (most common):
//    const { rows } = await db.query('SELECT * FROM sessions WHERE token_hash = $1', [hash]);
//
// 2. Convenience helpers for common patterns:
//    const session = await db.findOne('sessions', { token_hash: hash });
//    const sessions = await db.findMany('sessions', { user_id: id }, { limit: 10 });
//    const inserted = await db.insertOne('sessions', { user_id: ..., ... });
//    const updated = await db.update('sessions', { revoked_at: now }, { token_hash: hash });
//    const deleted = await db.deleteWhere('sessions', { token_hash: hash });
//
// 3. Transactions:
//    await db.transaction(async (client) => {
//      await client.query('UPDATE ...');
//      await client.query('INSERT ...');
//    });

const { Pool } = require('pg');
const { Signer } = require('@aws-sdk/rds-signer');

const RDS_PROXY_HOST = process.env.RDS_PROXY_HOST;
const RDS_PORT       = parseInt(process.env.RDS_PORT || '5432', 10);
const RDS_DATABASE   = process.env.RDS_DATABASE || 'myspark';
const RDS_USER       = process.env.RDS_USER || 'myspark_admin';
const AWS_REGION     = process.env.AWS_REGION || 'us-east-2';

let cachedToken = null;
let cachedTokenExpiry = 0;
let pool = null;

async function getAuthToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiry) {
    return cachedToken;
  }
  
  const signer = new Signer({
    region:   AWS_REGION,
    hostname: RDS_PROXY_HOST,
    port:     RDS_PORT,
    username: RDS_USER
  });
  
  cachedToken = await signer.getAuthToken();
  cachedTokenExpiry = now + (14 * 60 * 1000);
  return cachedToken;
}

function getPool() {
  if (pool) return pool;
  
  pool = new Pool({
    host: RDS_PROXY_HOST,
    port: RDS_PORT,
    user: RDS_USER,
    database: RDS_DATABASE,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    password: async () => await getAuthToken()
  });
  
  pool.on('error', (err) => {
    console.error('[db] Pool error:', err.message);
  });
  
  return pool;
}

// ============================================================
// Raw query - escape hatch for everything custom
// ============================================================

async function query(text, params) {
  const p = getPool();
  return p.query(text, params);
}

// ============================================================
// Identifier safety
// ============================================================

function quoteTable(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error('Invalid table name: ' + name);
  }
  return '"' + name + '"';
}

function quoteColumn(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error('Invalid column name: ' + name);
  }
  return '"' + name + '"';
}

// ============================================================
// WHERE clause builder
// 
// Supports filter object syntax:
//   { col: value }                        → col = value
//   { col: null }                         → col IS NULL  
//   { col: { op: 'IS_NULL' } }            → col IS NULL
//   { col: { op: 'NOT_NULL' } }           → col IS NOT NULL
//   { col: { op: 'in', value: [...] } }   → col IN (...)
//   { col: { op: 'gte', value: x } }      → col >= x
//   { col: { op: 'gt'/'lt'/'lte'/'neq'/'like'/'ilike', value: x } }
// ============================================================

function buildWhere(filters, startParam) {
  if (!filters || Object.keys(filters).length === 0) {
    return { sql: '', params: [], nextParam: startParam || 1 };
  }
  
  const parts = [];
  const params = [];
  let p = startParam || 1;
  
  for (const [col, val] of Object.entries(filters)) {
    const colSafe = quoteColumn(col);
    
    // null/undefined → IS NULL
    if (val === null || val === undefined) {
      parts.push(`${colSafe} IS NULL`);
      continue;
    }
    
    // Object with .op = special operator
    if (val && typeof val === 'object' && !Array.isArray(val) && val.op) {
      const op = String(val.op).toLowerCase();
      
      if (op === 'is_null') {
        parts.push(`${colSafe} IS NULL`);
        continue;
      }
      if (op === 'not_null') {
        parts.push(`${colSafe} IS NOT NULL`);
        continue;
      }
      if (op === 'in') {
        if (!Array.isArray(val.value) || val.value.length === 0) {
          parts.push('FALSE');
          continue;
        }
        const placeholders = val.value.map(() => '$' + (p++)).join(',');
        parts.push(`${colSafe} IN (${placeholders})`);
        params.push(...val.value);
        continue;
      }
      
      const opMap = {
        eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=',
        like: 'LIKE', ilike: 'ILIKE'
      };
      const sqlOp = opMap[op] || '=';
      parts.push(`${colSafe} ${sqlOp} $${p++}`);
      params.push(val.value);
      continue;
    }
    
    // Plain value → equality
    parts.push(`${colSafe} = $${p++}`);
    params.push(val);
  }
  
  return {
    sql: parts.length ? 'WHERE ' + parts.join(' AND ') : '',
    params,
    nextParam: p
  };
}

// ============================================================
// Convenience helpers
// ============================================================

async function findOne(table, filters, options) {
  const tbl = quoteTable(table);
  const where = buildWhere(filters, 1);
  const select = (options && options.select) || '*';
  const sql = `SELECT ${select} FROM ${tbl} ${where.sql} LIMIT 1`.trim();
  const result = await query(sql, where.params);
  return result.rows[0] || null;
}

async function findMany(table, filters, options) {
  options = options || {};
  const tbl = quoteTable(table);
  const where = buildWhere(filters || {}, 1);
  
  const orderParts = [];
  if (options.orderBy) {
    const orderArr = Array.isArray(options.orderBy) ? options.orderBy : [options.orderBy];
    for (const o of orderArr) {
      const colName = o.col || o.column;
      const colSafe = quoteColumn(colName);
      const desc = (o.asc === false) || (o.ascending === false) || (o.direction === 'desc');
      orderParts.push(`${colSafe} ${desc ? 'DESC' : 'ASC'} NULLS LAST`);
    }
  }
  const orderSql = orderParts.length ? 'ORDER BY ' + orderParts.join(', ') : '';
  
  const tail = [];
  let p = where.nextParam;
  const tailParams = [];
  if (options.limit !== undefined && options.limit !== null) {
    tail.push(`LIMIT $${p++}`);
    tailParams.push(options.limit);
  }
  if (options.offset !== undefined && options.offset !== null) {
    tail.push(`OFFSET $${p++}`);
    tailParams.push(options.offset);
  }
  
  const select = options.select || '*';
  const sql = `SELECT ${select} FROM ${tbl} ${where.sql} ${orderSql} ${tail.join(' ')}`.trim();
  const result = await query(sql, [...where.params, ...tailParams]);
  return result.rows;
}

async function insert(table, rows, options) {
  options = options || {};
  const tbl = quoteTable(table);
  const rowsArr = Array.isArray(rows) ? rows : [rows];
  if (rowsArr.length === 0) return [];
  
  const cols = Array.from(new Set(rowsArr.flatMap(r => Object.keys(r))));
  const colsSafe = cols.map(quoteColumn);
  
  const valuesParts = [];
  const params = [];
  let p = 1;
  for (const row of rowsArr) {
    const placeholders = cols.map(c => {
      params.push(row[c] === undefined ? null : row[c]);
      return '$' + (p++);
    });
    valuesParts.push('(' + placeholders.join(', ') + ')');
  }
  
  let onConflict = '';
  if (options.onConflict) {
    // 2026-05-21: accept either a string (single column) or array
    // (composite key). Composite is required for multi-column UNIQUE
    // constraints like appointment_reminders(subaccount_id, appointment_id,
    // reminder_type). Backward compatible: string callers continue to work.
    const conflictCols = Array.isArray(options.onConflict)
      ? options.onConflict
      : [options.onConflict];
    const conflictColsSafe = conflictCols.map(quoteColumn);
    const conflictTarget = conflictColsSafe.join(', ');
    if (options.onConflictAction === 'ignore' || options.onConflictAction === 'do_nothing') {
      onConflict = `ON CONFLICT (${conflictTarget}) DO NOTHING`;
    } else {
      const updateSet = colsSafe
        .filter(c => !conflictColsSafe.includes(c))
        .map(c => `${c} = EXCLUDED.${c}`)
        .join(', ');
      onConflict = `ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updateSet}`;
    }
  }
  
  const returning = options.returning || '*';
  const sql = `INSERT INTO ${tbl} (${colsSafe.join(', ')}) VALUES ${valuesParts.join(', ')} ${onConflict} RETURNING ${returning}`.trim();
  
  const result = await query(sql, params);
  return result.rows;
}

async function insertOne(table, row, options) {
  const rows = await insert(table, row, options);
  return rows[0] || null;
}

async function update(table, values, filters, options) {
  options = options || {};
  const tbl = quoteTable(table);
  const cols = Object.keys(values);
  if (cols.length === 0) {
    throw new Error('update() called with no values');
  }
  
  const colsSafe = cols.map(quoteColumn);
  const params = [];
  let p = 1;
  const setParts = colsSafe.map((c, i) => {
    params.push(values[cols[i]] === undefined ? null : values[cols[i]]);
    return `${c} = $${p++}`;
  });
  
  const where = buildWhere(filters, p);
  
  if (where.sql === '' && !options.allowUpdateAll) {
    throw new Error('update() called without WHERE clause. Pass allowUpdateAll: true to confirm.');
  }
  
  const returning = options.returning || '*';
  const sql = `UPDATE ${tbl} SET ${setParts.join(', ')} ${where.sql} RETURNING ${returning}`.trim();
  
  const result = await query(sql, [...params, ...where.params]);
  return result.rows;
}

async function deleteWhere(table, filters, options) {
  options = options || {};
  const tbl = quoteTable(table);
  const where = buildWhere(filters, 1);
  
  if (where.sql === '' && !options.allowDeleteAll) {
    throw new Error('deleteWhere() called without WHERE clause. Pass allowDeleteAll: true to confirm.');
  }
  
  const returning = options.returning || '*';
  const sql = `DELETE FROM ${tbl} ${where.sql} RETURNING ${returning}`.trim();
  
  const result = await query(sql, where.params);
  return result.rows;
}

async function count(table, filters) {
  const tbl = quoteTable(table);
  const where = buildWhere(filters || {}, 1);
  const sql = `SELECT COUNT(*)::int AS n FROM ${tbl} ${where.sql}`.trim();
  const result = await query(sql, where.params);
  return result.rows[0].n;
}

async function transaction(callback) {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function getClient() {
  const p = getPool();
  return p.connect();
}

async function _close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  query,
  findOne,
  findMany,
  insert,
  insertOne,
  update,
  deleteWhere,
  count,
  transaction,
  getClient,
  _close,
  buildWhere,
  quoteTable,
  quoteColumn
};
