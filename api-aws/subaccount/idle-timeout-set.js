// api/subaccount/idle-timeout-set.js (Lambda version)
// ANY /api/subaccount/idle-timeout-set
// Admin-only. Sets the subaccount idle-logout window (minutes; 0 = Never).
//
// The value drives both the client idle timer and server-side enforcement in
// lib/subaccount-auth.js validateSession. Stored at
// subaccount_data.data.settings.idleTimeoutMinutes via jsonb_set so a
// concurrent blob save cannot clobber it.
//
// When set to 0 (Never): requires warningAccepted=true, writes a security
// audit row (the HIPAA addressable-safeguard exception record), and fires an
// agency-scope ops alert to hello@litbiz.io. Switching AWAY from Never does
// not alert (we only track when protection is dropped).

const db = require('./lib/db');
const { requireSubaccountAuth } = require('./lib/require-subaccount-auth');
const { logAudit } = require('./lib/audit');
const { wrap } = require('./lib/lambda-adapter');
const { sendEmail } = require('./lib/mailgun');

const ALLOWED_MINUTES = [0, 10, 15, 20, 30];
const OPS_ALERT_TO = 'hello@litbiz.io';

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Admin-only, server-enforced (denial is auto-audited by the helper).
  const auth = await requireSubaccountAuth(req, res, { requireRole: 'admin' });
  if (!auth) return;

  const body = req.body || {};
  const minutes = body.minutes;
  const warningAccepted = body.warningAccepted === true;

  if (!ALLOWED_MINUTES.includes(minutes)) {
    return res.status(400).json({
      error: 'minutes must be one of 0, 10, 15, 20, 30',
      code: 'INVALID_MINUTES'
    });
  }

  // Never requires explicit consent, server-enforced. This guarantees the
  // consent flag exists even if the UI modal is bypassed.
  if (minutes === 0 && !warningAccepted) {
    return res.status(400).json({
      error: 'Setting idle logout to Never requires warningAccepted=true',
      code: 'CONSENT_REQUIRED'
    });
  }

  const subaccountId = auth.subaccount_id;

  try {
    // Read the prior value so the audit row + alert carry the real previous setting.
    const cur = await db.query(
      `SELECT data->'settings'->>'idleTimeoutMinutes' AS prev FROM subaccount_data WHERE subaccount_id = $1 LIMIT 1`,
      [subaccountId]
    );
    const prevRaw = cur.rows[0] ? cur.rows[0].prev : null;
    const prevVal = (prevRaw === null || prevRaw === undefined) ? null : parseInt(prevRaw, 10);

    // Targeted nested write. Does NOT rewrite the whole blob, so a concurrent
    // data-save cannot clobber unrelated settings keys. Creates the settings
    // object if missing (jsonb_set with create_missing default true).
    await db.query(
      `UPDATE subaccount_data
         SET data = jsonb_set(
               COALESCE(data, '{}'::jsonb),
               '{settings,idleTimeoutMinutes}',
               to_jsonb($2::int),
               true
             ),
             updated_at = NOW()
       WHERE subaccount_id = $1`,
      [subaccountId, minutes]
    );

    // Audit every change to this security control.
    await logAudit({
      req,
      actorType: 'subaccount',
      actorId: auth.user_id,
      actorUsername: auth.username,
      actorRole: auth.role,
      action: 'subaccount.security.idle_timeout_changed',
      targetType: 'subaccount_settings',
      targetId: subaccountId,
      targetSubaccountId: subaccountId,
      metadata: {
        old_value: prevVal,
        new_value: minutes,
        is_never: minutes === 0,
        warning_accepted: minutes === 0 ? true : undefined
      }
    });

    // Ops alert ONLY when switching TO Never. Agency-scope (internal, not the
    // clinic's mailbox). Best-effort: never block the save on email failure.
    if (minutes === 0) {
      const slug = subaccountId.replace(/^sub-/, '');
      const when = new Date().toISOString();
      sendEmail(null, {
        scope: 'agency',
        source: 'idle-timeout-set',
        to: OPS_ALERT_TO,
        subject: 'Idle logout set to NEVER: ' + slug,
        text: 'A subaccount disabled automatic idle logout.\n\n'
          + 'Subaccount: ' + slug + ' (' + subaccountId + ')\n'
          + 'Changed by: ' + auth.username + ' (role: ' + auth.role + ', user ' + auth.user_id + ')\n'
          + 'Previous window: ' + (prevVal === null ? 'unset (default 15)' : (prevVal === 0 ? 'Never' : prevVal + ' min')) + '\n'
          + 'New window: Never (no idle logout)\n'
          + 'When: ' + when + '\n\n'
          + 'This is the documented exception record for the HIPAA automatic-logoff safeguard.',
        html: '<p>A subaccount disabled automatic idle logout.</p>'
          + '<ul>'
          + '<li><strong>Subaccount:</strong> ' + slug + ' (' + subaccountId + ')</li>'
          + '<li><strong>Changed by:</strong> ' + auth.username + ' (role: ' + auth.role + ', user ' + auth.user_id + ')</li>'
          + '<li><strong>Previous window:</strong> ' + (prevVal === null ? 'unset (default 15)' : (prevVal === 0 ? 'Never' : prevVal + ' min')) + '</li>'
          + '<li><strong>New window:</strong> Never (no idle logout)</li>'
          + '<li><strong>When:</strong> ' + when + '</li>'
          + '</ul>'
          + '<p>This is the documented exception record for the HIPAA automatic-logoff safeguard.</p>'
      }).catch(function(e){ console.error('idle-timeout ops alert failed (non-fatal):', e && e.message); });
    }

    return res.status(200).json({ ok: true, idleTimeoutMinutes: minutes });
  } catch (e) {
    console.error('idle-timeout-set error:', e.message);
    return res.status(500).json({ error: 'Failed to update idle timeout' });
  }
}

exports.handler = wrap(handler);
