// GET /api/subaccount/conversations-since?ts=<iso-timestamp>
//
// Cheap polling endpoint. Returns just enough info to know whether the client's
// cached conversation list is stale, without sending the full list.
//
// Used by the conversations tab to tier polling intervals: poll this cheap
// endpoint frequently; only re-fetch the full list when this says something changed.
//
// Returns:
//   {
//     count: <number of conversations updated AFTER ts>,
//     newest_ts: <ISO timestamp of most recent change>,
//     server_ts: <current server time, client uses this for next poll>
//   }

const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;

  const subaccountId = auth.subaccount_id;
  const tsParam = (req.query && req.query.ts) ? String(req.query.ts) : null;

  try {
    let result;
    if (tsParam) {
      // Validate ts is a parseable timestamp; fall back to "all conversations" if not
      const d = new Date(tsParam);
      if (isNaN(d.getTime())) {
        result = await db.query(
          `SELECT COUNT(*)::int AS count, MAX(last_message_at) AS newest_ts
           FROM conversations
           WHERE subaccount_id = $1`,
          [subaccountId]
        );
      } else {
        result = await db.query(
          `SELECT COUNT(*)::int AS count, MAX(last_message_at) AS newest_ts
           FROM conversations
           WHERE subaccount_id = $1
             AND last_message_at > $2`,
          [subaccountId, d.toISOString()]
        );
      }
    } else {
      result = await db.query(
        `SELECT COUNT(*)::int AS count, MAX(last_message_at) AS newest_ts
         FROM conversations
         WHERE subaccount_id = $1`,
        [subaccountId]
      );
    }

    const row = result.rows[0] || { count: 0, newest_ts: null };

    return res.status(200).json({
      count: row.count || 0,
      newest_ts: row.newest_ts ? new Date(row.newest_ts).toISOString() : null,
      server_ts: new Date().toISOString()
    });
  } catch (err) {
    console.error('conversations-since error:', err);
    return res.status(500).json({ error: 'Failed to check' });
  }
}

exports.handler = wrap(handler);
