// api/cron/automations.js (Lambda)
//
// Time-based automation runner. Triggered hourly by EventBridge.
// For each subaccount where local time matches its send_hour (default 9 AM):
//   Evaluate all active time-based automations and fire matches.
//
// Manual invoke payload:
//   { dry_run: true }            log what would fire, no sends
//   { subaccount_id: "sub-..." } only process this subaccount
//   { force_hour: 9 }            require local hour = N (override default)
//   { force_send: true }         bypass hour-of-day check entirely
//
// Idempotency: handled by lib/automations.js via automation_runs UNIQUE constraint.
// Scheduled mode throws on errors so CloudWatch alarms fire.

const db = require('./lib/db');
const automations = require('./lib/automations');

const TIME_TRIGGERS = [
  'contact_birthday',
  'contact_age_days',
  'days_before_appointment',
  'days_after_appointment',
  'days_after_first_booking',
  'days_after_last_booking'
];

const DEFAULT_TZ = 'America/New_York';
const DEFAULT_SEND_HOUR = 9;

function getLocalHour(tz) {
  try {
    return parseInt(
      new Date().toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }),
      10
    );
  } catch (e) {
    return new Date().getUTCHours();
  }
}

async function findContactBirthdayMatches(subaccountId, tz) {
  const r = await db.query(
    "SELECT id AS contact_id FROM contacts " +
    "WHERE subaccount_id = $1 AND archived = false AND date_of_birth IS NOT NULL " +
    "AND EXTRACT(MONTH FROM date_of_birth) = EXTRACT(MONTH FROM (NOW() AT TIME ZONE $2)::date) " +
    "AND EXTRACT(DAY FROM date_of_birth) = EXTRACT(DAY FROM (NOW() AT TIME ZONE $2)::date)",
    [subaccountId, tz]
  );
  return r.rows.map(row => ({ contactId: row.contact_id }));
}

async function findContactAgeDaysMatches(subaccountId, tz, daysAfter) {
  const r = await db.query(
    "SELECT id AS contact_id FROM contacts " +
    "WHERE subaccount_id = $1 AND archived = false " +
    "AND ((created_at AT TIME ZONE $2)::date) = ((NOW() AT TIME ZONE $2)::date - ($3::int * INTERVAL '1 day'))",
    [subaccountId, tz, daysAfter]
  );
  return r.rows.map(row => ({ contactId: row.contact_id }));
}

async function findDaysBeforeAppointmentMatches(subaccountId, tz, daysBefore, serviceFilter) {
  let sql =
    "SELECT id AS appointment_id, contact_id, service_id, status FROM appointments " +
    "WHERE subaccount_id = $1 AND contact_id IS NOT NULL " +
    "AND date::date = ((NOW() AT TIME ZONE $2)::date + ($3::int * INTERVAL '1 day')) " +
    "AND status IN ('scheduled', 'confirmed', 'pending')";
  const params = [subaccountId, tz, daysBefore];
  if (serviceFilter) { sql += " AND service_id = $4"; params.push(serviceFilter); }
  const r = await db.query(sql, params);
  return r.rows.map(row => ({
    contactId: row.contact_id, appointmentId: row.appointment_id,
    serviceId: row.service_id, appointmentStatus: row.status
  }));
}

async function findDaysAfterAppointmentMatches(subaccountId, tz, daysAfter, statusFilter) {
  let sql =
    "SELECT id AS appointment_id, contact_id, service_id, status FROM appointments " +
    "WHERE subaccount_id = $1 AND contact_id IS NOT NULL " +
    "AND date::date = ((NOW() AT TIME ZONE $2)::date - ($3::int * INTERVAL '1 day'))";
  const params = [subaccountId, tz, daysAfter];
  if (statusFilter) { sql += " AND status = $" + (params.length + 1); params.push(statusFilter); }
  const r = await db.query(sql, params);
  return r.rows.map(row => ({
    contactId: row.contact_id, appointmentId: row.appointment_id,
    serviceId: row.service_id, appointmentStatus: row.status
  }));
}

async function findDaysAfterFirstBookingMatches(subaccountId, tz, daysAfter) {
  const r = await db.query(
    "SELECT contact_id, MIN(date) AS first_date FROM appointments " +
    "WHERE subaccount_id = $1 AND contact_id IS NOT NULL " +
    "GROUP BY contact_id " +
    "HAVING MIN(date)::date = ((NOW() AT TIME ZONE $2)::date - ($3::int * INTERVAL '1 day'))",
    [subaccountId, tz, daysAfter]
  );
  return r.rows.map(row => ({ contactId: row.contact_id }));
}

async function findDaysAfterLastBookingMatches(subaccountId, tz, daysAfter, statusFilter) {
  let sql = "SELECT contact_id, MAX(date) AS last_date FROM appointments " +
            "WHERE subaccount_id = $1 AND contact_id IS NOT NULL";
  const params = [subaccountId, tz];
  if (statusFilter) { sql += " AND status = $" + (params.length + 1); params.push(statusFilter); }
  sql += " GROUP BY contact_id " +
         "HAVING MAX(date)::date = ((NOW() AT TIME ZONE $2)::date - ($" + (params.length + 1) + "::int * INTERVAL '1 day'))";
  params.push(daysAfter);
  const r = await db.query(sql, params);
  return r.rows.map(row => ({ contactId: row.contact_id }));
}

async function findMatchesForAutomation(automation, subaccountId, tz) {
  const cfg = automation.trigger_config || {};
  switch (automation.trigger_type) {
    case 'contact_birthday':
      return findContactBirthdayMatches(subaccountId, tz);
    case 'contact_age_days':
      return findContactAgeDaysMatches(subaccountId, tz, parseInt(cfg.days_after || 0, 10));
    case 'days_before_appointment':
      return findDaysBeforeAppointmentMatches(
        subaccountId, tz, parseInt(cfg.days_before || 0, 10), cfg.service_id || null
      );
    case 'days_after_appointment':
      return findDaysAfterAppointmentMatches(
        subaccountId, tz, parseInt(cfg.days_after || 0, 10), cfg.status_filter || null
      );
    case 'days_after_first_booking':
      return findDaysAfterFirstBookingMatches(subaccountId, tz, parseInt(cfg.days_after || 0, 10));
    case 'days_after_last_booking':
      return findDaysAfterLastBookingMatches(
        subaccountId, tz, parseInt(cfg.days_after || 0, 10), cfg.status_filter || 'completed'
      );
    default:
      return [];
  }
}

async function processSubaccount(subaccountId, tz, sendHour, options, summary) {
  const localHour = getLocalHour(tz);
  if (!options.force_send) {
    const requiredHour = (options.force_hour != null) ? options.force_hour : sendHour;
    if (localHour !== requiredHour) return;
  }

  summary.subaccounts_processed.push({ subaccountId, tz, localHour, sendHour });

  const automationsRes = await db.query(
    "SELECT * FROM automations " +
    "WHERE subaccount_id = $1 AND active = true AND trigger_type = ANY($2::text[])",
    [subaccountId, TIME_TRIGGERS]
  );

  for (const automation of automationsRes.rows) {
    try {
      const matches = await findMatchesForAutomation(automation, subaccountId, tz);
      summary.matches[automation.id] = {
        trigger_type: automation.trigger_type,
        count: matches.length
      };
      if (options.dry_run) continue;
      for (const match of matches) {
        const ctx = Object.assign({ subaccountId }, match);
        await automations.fireAutomationTriggers(automation.trigger_type, ctx);
      }
    } catch (autoErr) {
      summary.errors.push({
        automation_id: automation.id,
        trigger_type: automation.trigger_type,
        error: autoErr.message
      });
      console.error('Automation eval error:', automation.id, autoErr.message);
    }
  }
}

exports.handler = async (event) => {
  const isScheduled = event && event['detail-type'] === 'Scheduled Event';
  const options = {
    dry_run: !!(event && event.dry_run),
    subaccount_id: event && event.subaccount_id,
    force_hour: (event && typeof event.force_hour === 'number') ? event.force_hour : null,
    force_send: !!(event && event.force_send)
  };

  const summary = {
    started_at: new Date().toISOString(),
    is_scheduled: isScheduled,
    options,
    subaccounts_eligible: 0,
    subaccounts_processed: [],
    matches: {},
    errors: []
  };

  try {
    const subParams = options.subaccount_id ? [options.subaccount_id, DEFAULT_TZ, DEFAULT_SEND_HOUR] : [DEFAULT_TZ, DEFAULT_SEND_HOUR];
    const filterSql = options.subaccount_id ? " AND s.id = $1" : "";
    const tzParamIdx = options.subaccount_id ? 2 : 1;
    const hourParamIdx = options.subaccount_id ? 3 : 2;

    const subRes = await db.query(
      "SELECT s.id, s.name, " +
      "COALESCE(sd.data->'settings'->>'timezone', $" + tzParamIdx + ") AS tz, " +
      "COALESCE((sd.data->'settings'->>'automation_send_hour')::int, $" + hourParamIdx + ") AS send_hour " +
      "FROM subaccounts s " +
      "LEFT JOIN subaccount_data sd ON sd.subaccount_id = s.id " +
      "WHERE s.active = true" + filterSql,
      subParams
    );

    summary.subaccounts_eligible = subRes.rows.length;

    for (const sub of subRes.rows) {
      try {
        await processSubaccount(sub.id, sub.tz, sub.send_hour, options, summary);
      } catch (subErr) {
        summary.errors.push({ subaccount_id: sub.id, error: subErr.message });
        console.error('Subaccount processing error:', sub.id, subErr.message);
      }
    }

    summary.finished_at = new Date().toISOString();

    if (isScheduled && summary.errors.length > 0) {
      console.error('Cron completed with errors:', JSON.stringify(summary.errors));
      throw new Error('Automation cron had ' + summary.errors.length + ' errors');
    }

    return summary;
  } catch (e) {
    summary.fatal_error = e.message;
    console.error('Automation cron fatal:', e);
    if (isScheduled) throw e;
    return summary;
  }
};
