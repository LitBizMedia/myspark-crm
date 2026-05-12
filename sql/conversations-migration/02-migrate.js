const db = require('./lib/db');
const crypto = require('crypto');

// Helpers
const uid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-6);
const replyToken = () => crypto.randomBytes(16).toString('hex'); // 32-char hex

const TEMPLATE_TO_SOURCE = {
  'appt-reminder': 'reminder',
  'appt-cancellation': 'cancellation',
  'appt-confirmation': 'confirmation',
  'booking-confirmation': 'widget'
};

const ADMIN_TEST_EMAILS = new Set([
  'patrick@litbiz.io',
  'info@litbizmedia.com',
  'hello@litbiz.io',
  'test@litbiz.io',
  'renamer@litbiz.io'
]);

exports.handler = async (event) => {
  const dryRun = event.dry_run === true;
  const log = [];
  const counts = {
    bucket_a_agency: 0,
    bucket_b_subaccount: 0,
    bucket_b_conversations_created: 0,
    bucket_c_skipped: 0,
    errors: 0,
    skipped_already_migrated: 0
  };

  // Load all email_log rows
  const allRows = await db.query(`
    SELECT id, subaccount_id, to_email, from_email, subject, template_type,
           resend_email_id, status, error_message, contact_id, sent_at
    FROM email_log
    ORDER BY sent_at ASC
  `);
  log.push(`Loaded ${allRows.rows.length} email_log rows`);

  // Classify
  const bucketA = []; // agency
  const bucketB = []; // subaccount transactional
  const bucketC = []; // skip

  for (const row of allRows.rows) {
    const isWelcome = row.template_type === 'welcome' || (row.subject && row.subject.startsWith('Your MySpark+ workspace is ready'));
    const isTransactional = ['appt-reminder','appt-cancellation','appt-confirmation','booking-confirmation'].includes(row.template_type);
    const isTestNullContact = row.contact_id === null && row.template_type === null && ADMIN_TEST_EMAILS.has(row.to_email);

    if (isWelcome) {
      bucketA.push(row);
    } else if (isTransactional && row.contact_id) {
      bucketB.push(row);
    } else if (isTestNullContact) {
      bucketC.push(row);
    } else {
      // Unclassified, default to skip with warning
      bucketC.push(row);
      log.push(`Unclassified row ${row.id}, to=${row.to_email}, template=${row.template_type}, contact=${row.contact_id} — routed to skip`);
    }
  }

  log.push(`Classified: A=${bucketA.length}, B=${bucketB.length}, C=${bucketC.length}`);

  // BUCKET A: Agency emails to agency_email_log
  for (const row of bucketA) {
    // Idempotency: skip if already migrated by resend_email_id
    if (row.resend_email_id) {
      const exists = await db.query(
        `SELECT 1 FROM agency_email_log WHERE resend_email_id = $1 LIMIT 1`,
        [row.resend_email_id]
      );
      if (exists.rows.length) {
        counts.skipped_already_migrated++;
        continue;
      }
    }

    if (!dryRun) {
      try {
        await db.query(`
          INSERT INTO agency_email_log (
            recipient_email, recipient_subaccount_id,
            from_email, subject, template_type,
            resend_email_id, status, error_message, sent_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
          row.to_email,
          row.subaccount_id,
          row.from_email,
          row.subject,
          row.template_type || 'welcome',
          row.resend_email_id,
          row.status,
          row.error_message,
          row.sent_at
        ]);
        counts.bucket_a_agency++;
      } catch (e) {
        counts.errors++;
        log.push(`Bucket A error on ${row.id}: ${e.message}`);
      }
    } else {
      counts.bucket_a_agency++;
    }
  }

  // BUCKET B: Subaccount transactional to conversations + conversation_messages
  // Group by (subaccount_id, contact_id) to create conversations first
  const conversationKeys = new Map();
  for (const row of bucketB) {
    const key = `${row.subaccount_id}::${row.contact_id}`;
    if (!conversationKeys.has(key)) {
      conversationKeys.set(key, { subaccount_id: row.subaccount_id, contact_id: row.contact_id, rows: [] });
    }
    conversationKeys.get(key).rows.push(row);
  }

  log.push(`Bucket B will create ${conversationKeys.size} conversations from ${bucketB.length} messages`);

  for (const [key, group] of conversationKeys.entries()) {
    // Idempotency: check if conversation already exists
    let convId;
    const existingConv = await db.query(
      `SELECT id FROM conversations
       WHERE subaccount_id = $1 AND contact_id = $2 AND channel = 'email'
       LIMIT 1`,
      [group.subaccount_id, group.contact_id]
    );

    if (existingConv.rows.length) {
      convId = existingConv.rows[0].id;
      log.push(`Conversation already exists for ${key}, id=${convId}`);
    } else {
      convId = 'conv_' + uid();
      const token = replyToken();
      const lastRow = group.rows[group.rows.length - 1]; // most recent (rows ordered ASC)

      if (!dryRun) {
        try {
          await db.query(`
            INSERT INTO conversations (
              id, subaccount_id, contact_id, channel, status,
              last_message_at, last_message_preview, last_message_direction,
              reply_token, created_at, updated_at
            ) VALUES ($1, $2, $3, 'email', 'open',
              $4, $5, 'outbound',
              $6, $7, NOW())
          `, [
            convId,
            group.subaccount_id,
            group.contact_id,
            lastRow.sent_at,
            (lastRow.subject || '').slice(0, 140),
            token,
            group.rows[0].sent_at  // created_at = first message
          ]);
          counts.bucket_b_conversations_created++;
        } catch (e) {
          counts.errors++;
          log.push(`Conversation create error for ${key}: ${e.message}`);
          continue;
        }
      } else {
        counts.bucket_b_conversations_created++;
      }
    }

    // Insert messages
    for (const row of group.rows) {
      // Idempotency: skip if already migrated by external_id (resend_email_id)
      if (row.resend_email_id) {
        const exists = await db.query(
          `SELECT 1 FROM conversation_messages
           WHERE external_id = $1 AND conversation_id = $2 LIMIT 1`,
          [row.resend_email_id, convId]
        );
        if (exists.rows.length) {
          counts.skipped_already_migrated++;
          continue;
        }
      }

      const msgId = 'msg_' + uid();
      const source = TEMPLATE_TO_SOURCE[row.template_type] || 'system';

      if (!dryRun) {
        try {
          await db.query(`
            INSERT INTO conversation_messages (
              id, conversation_id, subaccount_id,
              direction, channel, source,
              from_address, to_address, subject,
              body_text, body_html,
              external_id, status, error,
              sent_at, created_at
            ) VALUES ($1, $2, $3,
              'outbound', 'email', $4,
              $5, $6, $7,
              NULL, NULL,
              $8, $9, $10,
              $11, $11)
          `, [
            msgId, convId, row.subaccount_id,
            source,
            row.from_email, row.to_email, row.subject,
            row.resend_email_id, row.status, row.error_message,
            row.sent_at
          ]);
          counts.bucket_b_subaccount++;
        } catch (e) {
          counts.errors++;
          log.push(`Message insert error on ${row.id}: ${e.message}`);
        }
      } else {
        counts.bucket_b_subaccount++;
      }
    }
  }

  // BUCKET C: skip entirely
  counts.bucket_c_skipped = bucketC.length;

  // Final verification
  let verification = {};
  if (!dryRun) {
    const v1 = await db.query(`SELECT COUNT(*) AS cnt FROM agency_email_log`);
    const v2 = await db.query(`SELECT COUNT(*) AS cnt FROM conversations`);
    const v3 = await db.query(`SELECT COUNT(*) AS cnt FROM conversation_messages`);
    const v4 = await db.query(`SELECT COUNT(*) AS cnt FROM email_log`);
    verification = {
      agency_email_log_rows: v1.rows[0].cnt,
      conversations_rows: v2.rows[0].cnt,
      conversation_messages_rows: v3.rows[0].cnt,
      email_log_rows_still: v4.rows[0].cnt
    };
  }

  return {
    dry_run: dryRun,
    counts,
    verification,
    log: log.slice(-20),  // last 20 log entries to keep response small
    log_total_entries: log.length
  };
};
