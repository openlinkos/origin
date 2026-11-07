import { createRequire } from 'node:module';

/**
 * The worker of the PostgreSQL client (see client.ts): plain JavaScript evaluated as CommonJS in a
 * worker thread by sync-worker.ts, holding the one connection, through the `pg` driver. It requires
 * `pg` from the absolute path the client resolves (pgModulePath), so that it runs the same from the
 * compiled code and from the TypeScript sources under the tests. Nothing but the worker loads `pg`.
 *
 * One request is a batch: statements run one after another on the connection, each through the
 * simple protocol (several statements, no parameters) or the extended one (one statement, `$n`
 * parameters), until one fails. A batch saves round trips between the threads: the client's
 * `BEGIN IMMEDIATE` and the statement it wraps and its COMMIT, or a cursor's DECLARE and first FETCH,
 * go in one. A step may:
 *
 * - want one row (`want: 'one'`: the portal is executed for one row, and the rest is never sent),
 *   all of them, or none;
 * - be a FETCH of `fetch` rows: the cursor is done when fewer come back, and steps marked `ifDone`
 *   (its CLOSE, the COMMIT of its snapshot) run only then;
 * - be the BEGIN batch of a writing transaction (`store`): its last statement reads `store_format`,
 *   and the batch fails with StoreUpgradedError if the store's version is newer than `store`, or
 *   StoreMovedError if it was moved;
 * - be a COMMIT that must commit (`expectCommit`): PostgreSQL answers COMMIT in a failed transaction
 *   with ROLLBACK, without an error; this makes it one.
 *
 * Values come back as node:sqlite returns them: bigint and numeric as numbers (an error beyond 2^53,
 * as node:sqlite's), booleans as 1 and 0, bytea as bytes, everything else (json too) as text. Rows
 * are arrays; the client builds the objects.
 *
 * The connection: the session settings run on every connect. A batch outside any transaction
 * (`conn` unset) connects first if needed, retrying with backoff while the server cannot be reached
 * (0.2 s doubling to 5 s, 30 s in all); one inside a transaction names its connection (`conn`) and
 * fails if that connection is gone, because its transaction went with it. When the connection drops
 * during a batch, the batch fails with ConnectionLostError, unless it may run again on a new
 * connection: a read (`retry: 'read'`), or a write whose COMMIT was not yet sent (`retry: 'write'`),
 * which is retried once. A batch marked `rollback` that fails otherwise is rolled back.
 */
export const PG_WORKER_SOURCE = `(() => {
  'use strict';
  const { randomUUID } = require('node:crypto');
  let pg = null;
  let types = null;
  let client = null;
  let conn = null;

  // SQLSTATEs of a session that has ended: shutdown, crash, idle timeouts.
  const ENDED = new Set(['57P01', '57P02', '57P03', '57P05', '25P03']);
  const SOCKET = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT',
    'EHOSTUNREACH', 'EHOSTDOWN', 'ENETUNREACH', 'ENETDOWN', 'ENOTFOUND', 'EAI_AGAIN']);

  function load(data) {
    pg = require(data.pgPath);
    const bytea = pg.types.getTypeParser(17, 'text');
    const tooLarge = (text) => Object.assign(
      new RangeError('Value is too large to be represented as a JavaScript number: ' + text),
      { code: 'ERR_OUT_OF_RANGE' });
    const int8 = (text) => {
      const n = Number(text);
      if (!Number.isSafeInteger(n)) throw tooLarge(text);
      return n;
    };
    const numeric = (text) => {
      const n = Number(text);
      if (Math.abs(n) > Number.MAX_SAFE_INTEGER) throw tooLarge(text);
      return n;
    };
    const parsers = { 16: (v) => (v === 't' ? 1 : 0), 17: bytea, 20: int8, 21: Number, 23: Number,
      26: Number, 700: Number, 701: Number, 1700: numeric };
    const text = (v) => v;
    types = { getTypeParser: (oid, format) => (format === 'binary'
      ? pg.types.getTypeParser(oid, format) : parsers[oid] || text) };
  }

  function drop(c) {
    if (client === c) {
      client = null;
      conn = null;
    }
  }

  function transient(err) {
    const code = err && typeof err.code === 'string' ? err.code : '';
    return code.startsWith('08') || ENDED.has(code) || SOCKET.has(code)
      || /^(Connection terminated|timeout expired)/.test(String(err && err.message));
  }

  function isLost(err, c) {
    if (c !== client) return true;
    if (transient(err)) return true;
    if (err && (err.severity === 'FATAL' || err.severity === 'PANIC')) return true;
    return /not queryable/.test(String(err && err.message));
  }

  const LOST = {
    connect: 'cannot connect to the database: ',
    lost: 'the connection to the database was lost: ',
    commit: 'the connection to the database was lost during COMMIT, so the transaction may or may not have been saved: ',
  };

  function lostError(err, how) {
    const e = new Error(LOST[how] + String((err && err.message) || err));
    e.name = 'ConnectionLostError';
    if (err && typeof err.code === 'string') e.code = err.code;
    e.committing = how === 'commit';
    return e;
  }

  async function connectOnce(data) {
    const c = new pg.Client(Object.assign({}, data.connection, {
      types,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      connectionTimeoutMillis: data.connectTimeoutMs,
    }));
    c.on('error', () => drop(c));
    c.on('end', () => drop(c));
    try {
      await c.connect();
      await c.query(data.session);
      // Settings not every server has (one at a time: a failure would undo the others).
      for (const sql of data.sessionIfAny) await c.query(sql).catch(() => {});
    } catch (err) {
      c.end().catch(() => {});
      throw err;
    }
    client = c;
    conn = randomUUID();
    return c;
  }

  async function connect(data) {
    const started = Date.now();
    let delay = data.retryFirstMs;
    for (;;) {
      try {
        return await connectOnce(data);
      } catch (err) {
        const wait = Math.min(delay, data.retryMaxMs);
        if (!transient(err) || Date.now() - started + wait > data.retryTotalMs) throw err;
        await new Promise((resolve) => setTimeout(resolve, wait));
        delay = wait * 2;
      }
    }
  }

  function tooBig(cap) {
    return Object.assign(new Error('the result is larger than ' + Math.round(cap / 1048576)
      + ' MB: read it with iterate()'), { code: 'ORIGIN_RESULT_TOO_LARGE' });
  }

  function run(c, s) {
    let bytes = 0;
    return new Promise((resolve, reject) => {
      const one = s.want === 'one' && !s.simple;
      const q = new pg.Query(s.simple
        ? { text: s.sql, rowMode: 'array' }
        : { text: s.sql, values: s.params || [], rowMode: 'array', queryMode: 'extended',
            rows: one ? 1 : undefined });
      if (one) {
        // Executed for one row: once it has come, end the exchange with Sync instead of asking for
        // more (pg would fetch every row, one at a time). After an error from the server, Sync too:
        // the server ignores everything until it comes.
        let synced = false;
        q.handlePortalSuspended = (con) => {
          synced = true;
          con.sync();
        };
        const complete = q.handleCommandComplete;
        q.handleCommandComplete = function (msg, con) {
          synced = true;
          return complete.call(this, msg, con);
        };
        const empty = q.handleEmptyQuery;
        q.handleEmptyQuery = function (con) {
          synced = true;
          return empty.call(this, con);
        };
        const failed = q.handleError;
        q.handleError = function (err, con) {
          if (!synced && err && err.severity !== undefined && client === c) {
            synced = true;
            con.sync();
          }
          return failed.call(this, err, con);
        };
      }
      if (s.cap) {
        // The text the rows hold, about (UTF-16 units): no more than the cap is kept.
        const row = q.handleDataRow;
        q.handleDataRow = function (msg) {
          if (!this._canceledDueToError) {
            for (const f of msg.fields) if (f !== null) bytes += f.length;
            if (bytes > s.cap) {
              this._canceledDueToError = tooBig(s.cap);
              return;
            }
          }
          return row.call(this, msg);
        };
      }
      q.callback = (err, res) => (err ? reject(err) : resolve(res));
      c.query(q);
    }).then((res) => {
      const r = Array.isArray(res) ? res[res.length - 1] : res;
      return { fields: r.fields.map((f) => f.name), rows: r.rows, count: r.rowCount, command: r.command,
        bytes };
    });
  }

  function checkStore(r, newest) {
    const row = r.rows[0];
    if (!row) return;
    if (row[0] > newest) {
      throw Object.assign(new Error('the store has been upgraded'), { name: 'StoreUpgradedError', version: row[0] });
    }
    if (row[1] !== null) {
      throw Object.assign(new Error('the store has been moved'), { name: 'StoreMovedError', movedTo: row[1] });
    }
  }

  async function batch(req, data) {
    let retried = false;
    for (;;) {
      let c = null;
      let committing = false;
      try {
        if (req.conn) {
          if (!client || conn !== req.conn) {
            throw lostError(new Error('it ended while a transaction was open'), 'lost');
          }
          c = client;
        } else {
          c = client || (await connect(data));
        }
        const results = [];
        let done = false;
        for (const s of req.steps) {
          if (s.ifDone && !done) {
            results.push(null);
            continue;
          }
          if (s.commit) committing = true;
          const r = await run(c, s);
          if (s.fetch !== undefined) done = r.rows.length < s.fetch;
          if (s.store !== undefined) checkStore(r, s.store);
          if (s.expectCommit && r.command !== 'COMMIT') {
            throw Object.assign(new Error('the transaction was rolled back: a statement in it failed'),
              { code: '25P02', severity: 'ERROR' });
          }
          if (s.want === 'none') r.rows = [];
          results.push(r);
        }
        return { conn, results, done };
      } catch (err) {
        if (err && err.name === 'ConnectionLostError') throw err;
        if (c === null) throw transient(err) ? lostError(err, 'connect') : err;
        if (isLost(err, c)) {
          drop(c);
          c.end().catch(() => {});
          const again = req.retry === 'read' || (req.retry === 'write' && !committing);
          if (!retried && !req.conn && again) {
            retried = true;
            continue;
          }
          throw lostError(err, committing ? 'commit' : 'lost');
        }
        if (req.rollback && client === c) await c.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }
  }

  return async (req, { data }) => {
    if (!pg) load(data);
    switch (req.op) {
      case 'batch':
        return batch(req, data);
      case 'end': {
        const c = client;
        drop(c);
        if (c) await c.end().catch(() => {});
        return null;
      }
      case 'exit':
        // Tests: the worker dies while the next request runs.
        setTimeout(() => process.exit(70), req.afterMs || 0);
        return null;
    }
    throw new Error('unknown request ' + req.op);
  };
})()`;

/** Where `pg` is, for the worker to require (resolved here, never loaded). */
export function pgModulePath(): string {
  return createRequire(import.meta.url).resolve('pg');
}
