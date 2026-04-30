// api/agency/subaccount-update.js (Lambda version)
// POST /api/agency/subaccount-update
// Super admin: updates name, active flag, and/or bulk data for a subaccount.

const db = require('./lib/db');
const { requireAgencyAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAgencyAuth(req, res, { requireRole: 'super_admin' });
  if (!auth) return;

  const { id, name, active, data } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });

  try {
    // Update subaccounts table fields if provided
    const subSets = [];
    const subParams = [id];
    let p = 2;
    if (name !== undefined) { subSets.push(`name = $${p++}`); subParams.push(name); }
    if (active !== undefined) { subSets.push(`active = $${p++}`); subParams.push(!!active); }

    if (subSets.length > 0) {
      await db.query(
        `UPDATE subaccounts SET ${subSets.join(', ')} WHERE id = $1`,
        subParams
      );
    }

    // Update subaccount_data if provided
    if (data !== undefined) {
      await db.query(`
        UPDATE subaccount_data 
        SET data = $1::jsonb, updated_at = NOW() 
        WHERE subaccount_id = $2
      `, [JSON.stringify(data), id]);
    }

    await logAudit({
      req,
      actorType: 'agency',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'agency.subaccount.update',
      targetType: 'subaccount',
      targetId: id,
      targetSubaccountId: id,
      metadata: {
        name_changed: name !== undefined,
        active_changed: active !== undefined,
        data_changed: data !== undefined,
        active_value: active
      }
    });

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('subaccount-update error:', e.message);
    return res.status(500).json({ error: 'Failed to update subaccount' });
  }
}

exports.handler = wrap(handler);
