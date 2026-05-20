// PUT /api/subaccount/litbiz/sop/tasks
// Body: { client_id, task_key, done_date?, note? }
// done_date: ISO date string ('2026-05-18') or null to mark incomplete.
// note: optional string, max 2000 chars.
// Returns updated row.

const { requireLitBizAccess } = require('./lib/require-litbiz-access');
const { wrap } = require('./lib/lambda-adapter');
const { logAudit } = require('./lib/audit');
const db = require('./lib/db');

const MAX_NOTE_LEN = 2000;
// task_key format: 'service:cadence:idx' e.g. 'social:daily:0'
const TASK_KEY_RE = /^[a-z]+:[a-z]+:\d+$/;

async function handler(req, res) {
  try {
    if (req.method !== 'PUT' && req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const auth = await requireLitBizAccess(req, res);
    if (!auth) return;

    const body = (typeof req.body === 'object' && req.body) ? req.body : {};

    const clientId = typeof body.client_id === 'string' ? body.client_id : '';
    const taskKey = typeof body.task_key === 'string' ? body.task_key : '';

    if (!clientId) return res.status(400).json({ error: 'client_id_required' });
    if (!TASK_KEY_RE.test(taskKey)) return res.status(400).json({ error: 'task_key_invalid' });

    // Verify the client belongs to this subaccount
    const owns = await db.query(
      `SELECT id FROM litbiz_sop_clients
         WHERE id = $1 AND subaccount_id = $2 AND archived = FALSE`,
      [clientId, auth.subaccount_id]
    );
    if (owns.rows.length === 0) {
      return res.status(404).json({ error: 'client_not_found' });
    }

    let doneDate = null;
    if (Object.prototype.hasOwnProperty.call(body, 'done_date')) {
      const v = body.done_date;
      if (v === null || v === '') {
        doneDate = null;
      } else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
        doneDate = v;
      } else {
        return res.status(400).json({ error: 'done_date_invalid' });
      }
    }

    let note = null;
    let noteProvided = false;
    if (Object.prototype.hasOwnProperty.call(body, 'note')) {
      noteProvided = true;
      note = typeof body.note === 'string' ? body.note.slice(0, MAX_NOTE_LEN) : '';
    }

    // Decide done_by: set when we're marking done, clear when un-marking
    const doneBy = doneDate ? auth.user_id : null;

    // Upsert. If only note is being updated, preserve done_date and done_by.
    let sql, vals;
    if (Object.prototype.hasOwnProperty.call(body, 'done_date') && noteProvided) {
      sql = `INSERT INTO litbiz_sop_task_state (client_id, task_key, done_date, done_by, note, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (client_id, task_key) DO UPDATE
               SET done_date = EXCLUDED.done_date,
                   done_by = EXCLUDED.done_by,
                   note = EXCLUDED.note,
                   updated_at = NOW()
             RETURNING client_id, task_key, done_date, done_by, note, updated_at`;
      vals = [clientId, taskKey, doneDate, doneBy, note];
    } else if (Object.prototype.hasOwnProperty.call(body, 'done_date')) {
      sql = `INSERT INTO litbiz_sop_task_state (client_id, task_key, done_date, done_by, note, updated_at)
             VALUES ($1, $2, $3, $4, '', NOW())
             ON CONFLICT (client_id, task_key) DO UPDATE
               SET done_date = EXCLUDED.done_date,
                   done_by = EXCLUDED.done_by,
                   updated_at = NOW()
             RETURNING client_id, task_key, done_date, done_by, note, updated_at`;
      vals = [clientId, taskKey, doneDate, doneBy];
    } else if (noteProvided) {
      sql = `INSERT INTO litbiz_sop_task_state (client_id, task_key, done_date, done_by, note, updated_at)
             VALUES ($1, $2, NULL, NULL, $3, NOW())
             ON CONFLICT (client_id, task_key) DO UPDATE
               SET note = EXCLUDED.note,
                   updated_at = NOW()
             RETURNING client_id, task_key, done_date, done_by, note, updated_at`;
      vals = [clientId, taskKey, note];
    } else {
      return res.status(400).json({ error: 'no_fields' });
    }

    const result = await db.query(sql, vals);
    const row = result.rows[0];

    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.litbiz.sop.task.update',
      targetType: 'litbiz_sop_task',
      targetId: clientId + ':' + taskKey,
      targetSubaccountId: auth.subaccount_id,
      metadata: {
        task_key: taskKey,
        done: !!row.done_date,
        note_len: (row.note || '').length
      }
    });

    return res.status(200).json({
      client_id: row.client_id,
      task_key: row.task_key,
      done_date: row.done_date,
      done_by: row.done_by,
      note: row.note,
      updated_at: row.updated_at
    });
  } catch (e) {
    console.error('sop-task-update error:', e.message);
    return res.status(500).json({ error: 'task_update_failed' });
  }
}

exports.handler = wrap(handler);
