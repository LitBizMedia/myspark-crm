// POST /api/subaccount/staff-services-set
// Staff-centric service assignment. Takes a staffId and the exact list of
// serviceIds that staff member SHOULD belong to (the "universe" the UI showed),
// then reconciles the assigned_staff array on each service in that universe:
//   - add staffId to services in `service_ids`
//   - remove staffId from services in the universe but NOT in `service_ids`
// Atomic: one transaction, all-or-nothing (db.transaction wraps BEGIN/COMMIT/ROLLBACK).
//
// Guard: never let a removal drop a group-capable service below its
// group_staff_count. If any removal would, reject the WHOLE transaction and
// return the offending service names. No partial state.
//
// Classes are excluded entirely. The universe is individual-type services only;
// any class id passed in is ignored (filtered by type <> 'class' in the lock query).
// Classes staff via instructor_id per session.

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');

// Sentinel thrown inside the transaction so db.transaction rolls back, then
// caught outside to shape the 409. Carries the blocked-service list.
function GroupMinError(blocked) {
  this.name = 'GroupMinError';
  this.blocked = blocked;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireSubaccountAuth(req, res);
  if (!auth) return;
  const subaccountId = auth.subaccount_id;

  const body = req.body || {};
  const staffId = body.staff_id;
  // The full set of service ids the UI presented as togglable (the universe).
  const universe = Array.isArray(body.universe_service_ids) ? body.universe_service_ids : null;
  // The subset within the universe that should HAVE this staff after the save.
  const wanted = Array.isArray(body.service_ids) ? body.service_ids : [];

  if (!staffId || typeof staffId !== 'string') {
    return res.status(400).json({ error: 'staff_id is required' });
  }
  if (!universe || !universe.length) {
    return res.status(400).json({ error: 'universe_service_ids is required and must be non-empty' });
  }

  // Validate staff belongs to this subaccount.
  const staffRow = await db.query(
    `SELECT id FROM subaccount_users WHERE id = $1 AND subaccount_id = $2`,
    [staffId, subaccountId]
  );
  if (!staffRow.rows.length) {
    return res.status(400).json({ error: 'staff_id does not belong to subaccount' });
  }

  const wantedSet = new Set(wanted);

  let result;
  try {
    result = await db.transaction(async (client) => {
      // Lock the universe rows for this subaccount. Exclude classes: the
      // reconcile universe is individual-type only. Any class id passed in
      // won't match and is ignored.
      const svcRes = await client.query(
        `SELECT id, name, type, assigned_staff, group_capable, group_staff_count
           FROM services
          WHERE subaccount_id = $1 AND id = ANY($2) AND type <> 'class'
          FOR UPDATE`,
        [subaccountId, universe]
      );

      const blocked = [];
      const updates = [];

      for (const svc of svcRes.rows) {
        const current = Array.isArray(svc.assigned_staff)
          ? svc.assigned_staff
          : (typeof svc.assigned_staff === 'string' ? JSON.parse(svc.assigned_staff || '[]') : []);
        const has = current.includes(staffId);
        const shouldHave = wantedSet.has(svc.id);

        if (has === shouldHave) continue; // no change for this service

        let next;
        if (shouldHave) {
          next = current.concat([staffId]);
        } else {
          next = current.filter(function (x) { return x !== staffId; });
          // Group-minimum guard on removal.
          if (svc.group_capable) {
            const minCount = parseInt(svc.group_staff_count) || 2;
            if (next.length < minCount) {
              blocked.push({ id: svc.id, name: svc.name, min: minCount, would_be: next.length });
              continue;
            }
          }
        }
        updates.push({ id: svc.id, next: next });
      }

      // Any block fails the whole save. Throw to trigger rollback.
      if (blocked.length) throw new GroupMinError(blocked);

      for (const u of updates) {
        await client.query(
          `UPDATE services SET assigned_staff = $1, updated_at = NOW()
            WHERE id = $2 AND subaccount_id = $3`,
          [JSON.stringify(u.next), u.id, subaccountId]
        );
      }

      return { changed: updates.length, changed_ids: updates.map(function (u) { return u.id; }) };
    });
  } catch (e) {
    if (e instanceof GroupMinError) {
      return res.status(409).json({
        error: 'group_minimum',
        message: 'Removing this staff member would drop group services below their required staff count.',
        blocked: e.blocked
      });
    }
    console.error('staff-services-set failed:', e);
    return res.status(500).json({ error: 'save failed', detail: e.message });
  }

  await logAudit({
    req,
    actorType: 'subaccount',
    actorId: auth.user_id,
    actorUsername: auth.username,
    actorRole: auth.role,
    action: 'subaccount.staff.services_set',
    targetType: 'staff',
    targetId: staffId,
    targetSubaccountId: subaccountId,
    metadata: {
      universe_count: universe.length,
      wanted_count: wanted.length,
      changed_count: result.changed
    }
  });

  return res.status(200).json({ ok: true, changed: result.changed, changed_ids: result.changed_ids });
}

exports.handler = wrap(handler);
