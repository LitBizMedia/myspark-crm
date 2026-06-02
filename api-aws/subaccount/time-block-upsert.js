// POST /api/subaccount/time-block-upsert
const db = require('./lib/db');
const { wrap } = require('./lib/lambda-adapter');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');

function uid() {
  return 'tb' + Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// Accepts 'HH:MM' (24h). Returns minutes since midnight, or null if invalid.
function toMin(t) {
  if (!t || typeof t !== 'string') return null;
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}

function blockToFrontend(row) {
  return {
    id: row.id,
    assignedTo: row.staff_id,
    date: row.block_date instanceof Date ? row.block_date.toISOString().slice(0,10) : String(row.block_date).slice(0,10),
    startTime: row.start_time,
    endTime: row.end_time,
    label: row.label || '',
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  try {
    const b = req.body || {};
    const id = b.id || null;
    const staffId = b.staff_id;
    const blockDate = b.block_date ? String(b.block_date).trim() : '';
    const startTime = b.start_time ? String(b.start_time).trim() : '';
    const endTime = b.end_time ? String(b.end_time).trim() : '';
    const label = b.label ? String(b.label).trim().slice(0, 200) : null;

    if (!staffId) return res.status(400).json({ error: 'staff_id is required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(blockDate)) return res.status(400).json({ error: 'block_date must be YYYY-MM-DD' });

    const sMin = toMin(startTime), eMin = toMin(endTime);
    if (sMin === null) return res.status(400).json({ error: 'start_time must be HH:MM' });
    if (eMin === null) return res.status(400).json({ error: 'end_time must be HH:MM' });
    if (eMin <= sMin) return res.status(400).json({ error: 'end_time must be after start_time' });

    // Validate staff belongs to this subaccount (cross-tenant guard).
    const u = await db.query(
      `SELECT id FROM subaccount_users WHERE id = $1 AND subaccount_id = $2`,
      [staffId, auth.subaccount_id]
    );
    if (!u.rows.length) return res.status(404).json({ error: 'Staff member not found' });

    let row, isUpdate = false;
    if (id) {
      const r = await db.query(
        `UPDATE time_blocks
            SET staff_id=$3, block_date=$4, start_time=$5, end_time=$6, label=$7
          WHERE id=$1 AND subaccount_id=$2
          RETURNING *`,
        [id, auth.subaccount_id, staffId, blockDate, startTime, endTime, label]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Time block not found' });
      row = r.rows[0];
      isUpdate = true;
    } else {
      const newId = uid();
      const r = await db.query(
        `INSERT INTO time_blocks (id, subaccount_id, staff_id, block_date, start_time, end_time, label)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [newId, auth.subaccount_id, staffId, blockDate, startTime, endTime, label]
      );
      row = r.rows[0];
    }

    await logAudit({
      req, actorType: 'subaccount', actorId: auth.user_id,
      actorUsername: auth.username, actorRole: auth.role,
      action: isUpdate ? 'subaccount.time_block.update' : 'subaccount.time_block.create',
      targetType: 'time_block', targetId: row.id,
      targetSubaccountId: auth.subaccount_id,
      metadata: { staff_id: staffId, block_date: blockDate, start_time: startTime, end_time: endTime }
    });

    return res.status(200).json({ success: true, id: row.id, timeBlock: blockToFrontend(row) });
  } catch (e) {
    console.error('time-block-upsert error:', e.message);
    return res.status(500).json({ error: 'Failed to save time block' });
  }
}
exports.handler = wrap(handler);
