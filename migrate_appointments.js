// migrate_appointments.js
// One-time migration: reads appointments from subaccount_data blobs
// and inserts them into the new appointments table.
// Run with: node migrate_appointments.js

const SUPABASE_URL = 'https://jytnzqaatkdtcflysadw.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: SUPABASE_SERVICE_ROLE_KEY environment variable is required.');
  console.error('Run with: SUPABASE_SERVICE_ROLE_KEY=your_key node migrate_appointments.js');
  process.exit(1);
}

function svcHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY
  }, extra || {});
}

async function main() {
  console.log('Fetching all subaccount data blobs...');

  const res = await fetch(SUPABASE_URL + '/rest/v1/subaccount_data?select=subaccount_id,data', {
    headers: svcHeaders()
  });

  if (!res.ok) {
    console.error('Failed to fetch subaccount_data:', res.status, await res.text());
    process.exit(1);
  }

  const rows = await res.json();
  console.log('Found ' + rows.length + ' subaccounts.');

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const row of rows) {
    const subaccountId = row.subaccount_id;
    const appointments = row.data && row.data.appointments;

    if (!appointments || !appointments.length) {
      console.log(subaccountId + ': no appointments, skipping.');
      continue;
    }

    console.log(subaccountId + ': migrating ' + appointments.length + ' appointments...');

    const toInsert = appointments.map(function(a) {
      return {
        id: a.id,
        subaccount_id: subaccountId,
        title: a.title || 'Untitled',
        contact_id: a.contactId || null,
        assigned_to: a.assignedTo || null,
        date: a.date,
        time: a.time || null,
        duration: parseInt(a.duration) || 60,
        status: a.status || 'scheduled',
        location: a.location || null,
        notes: a.notes || null,
        created_at: a.createdAt || new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
    }).filter(function(a) { return a.id && a.date; });

    if (!toInsert.length) {
      console.log(subaccountId + ': no valid appointments after filtering.');
      continue;
    }

    const insertRes = await fetch(SUPABASE_URL + '/rest/v1/appointments', {
      method: 'POST',
      headers: svcHeaders({
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      }),
      body: JSON.stringify(toInsert)
    });

    if (!insertRes.ok) {
      const err = await insertRes.text();
      console.error(subaccountId + ': INSERT FAILED: ' + err);
      totalErrors += toInsert.length;
    } else {
      console.log(subaccountId + ': inserted ' + toInsert.length + ' appointments.');
      totalInserted += toInsert.length;
    }
  }

  console.log('\nMigration complete.');
  console.log('Inserted: ' + totalInserted);
  console.log('Skipped: ' + totalSkipped);
  console.log('Errors: ' + totalErrors);
}

main().catch(function(e) {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
