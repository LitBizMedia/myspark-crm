const db = require('./lib/db');
exports.handler = async (event) => {
  const results = [];

  // 1. conversations table
  await db.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
      contact_id TEXT NOT NULL,

      channel TEXT NOT NULL DEFAULT 'email'
        CHECK (channel IN ('email','sms','chat')),

      status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','closed','archived')),

      assigned_to TEXT,
      last_message_at TIMESTAMPTZ,
      last_manual_message_at TIMESTAMPTZ,
      last_inbound_message_at TIMESTAMPTZ,
      last_message_preview TEXT,
      last_message_direction TEXT
        CHECK (last_message_direction IN ('inbound','outbound')),
      unread_count INTEGER NOT NULL DEFAULT 0,

      reply_token TEXT NOT NULL UNIQUE,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      UNIQUE (subaccount_id, contact_id, channel)
    )
  `);
  results.push('conversations table created');

  await db.query(`CREATE INDEX IF NOT EXISTS idx_conv_subaccount_status ON conversations(subaccount_id, status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_conv_subaccount_last_msg ON conversations(subaccount_id, last_message_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_conv_contact ON conversations(contact_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_conv_assigned ON conversations(assigned_to) WHERE assigned_to IS NOT NULL`);
  results.push('conversations indexes created');

  // 2. conversation_messages table
  await db.query(`
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,

      direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
      channel TEXT NOT NULL CHECK (channel IN ('email','sms','chat')),

      source TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('manual','reminder','confirmation','cancellation','widget','system')),

      from_address TEXT,
      to_address TEXT,
      cc_addresses JSONB,
      subject TEXT,
      body_text TEXT,
      body_html TEXT,
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb,

      external_id TEXT,
      external_message_id TEXT,
      in_reply_to TEXT,

      status TEXT NOT NULL DEFAULT 'sent'
        CHECK (status IN ('queued','sent','delivered','failed','received','bounced')),
      error TEXT,

      sent_by_user_id TEXT,
      sent_at TIMESTAMPTZ,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  results.push('conversation_messages table created');

  await db.query(`CREATE INDEX IF NOT EXISTS idx_convmsg_conv ON conversation_messages(conversation_id, created_at)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_convmsg_external ON conversation_messages(external_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_convmsg_subaccount ON conversation_messages(subaccount_id, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_convmsg_message_id ON conversation_messages(external_message_id) WHERE external_message_id IS NOT NULL`);
  results.push('conversation_messages indexes created');

  // 3. agency_email_log table
  await db.query(`
    CREATE TABLE IF NOT EXISTS agency_email_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      recipient_email TEXT NOT NULL,
      recipient_user_id TEXT,
      recipient_subaccount_id TEXT,
      from_email TEXT NOT NULL,
      subject TEXT,
      template_type TEXT,
      resend_email_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      error_message TEXT,
      sent_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  results.push('agency_email_log table created');

  await db.query(`CREATE INDEX IF NOT EXISTS idx_agency_email_recipient ON agency_email_log(recipient_email, sent_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_agency_email_template ON agency_email_log(template_type)`);
  results.push('agency_email_log indexes created');

  // 4. subaccount_email_domains: add inbound fields
  await db.query(`
    ALTER TABLE subaccount_email_domains
      ADD COLUMN IF NOT EXISTS inbound_subdomain TEXT NOT NULL DEFAULT 'reply',
      ADD COLUMN IF NOT EXISTS inbound_status TEXT NOT NULL DEFAULT 'not_setup',
      ADD COLUMN IF NOT EXISTS inbound_mx_target TEXT,
      ADD COLUMN IF NOT EXISTS inbound_verified_at TIMESTAMPTZ
  `);
  results.push('subaccount_email_domains extended with inbound fields');

  // Add CHECK constraint separately (cant be in ADD COLUMN IF NOT EXISTS)
  // First check if constraint already exists
  const constraintCheck = await db.query(`
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'subaccount_email_domains'
      AND constraint_name = 'subaccount_email_domains_inbound_status_check'
  `);
  if (constraintCheck.rows.length === 0) {
    await db.query(`
      ALTER TABLE subaccount_email_domains
      ADD CONSTRAINT subaccount_email_domains_inbound_status_check
      CHECK (inbound_status IN ('not_setup','pending','verified','failed'))
    `);
    results.push('inbound_status CHECK constraint added');
  } else {
    results.push('inbound_status CHECK constraint already exists');
  }

  // 5. inbound_unmatched table
  await db.query(`
    CREATE TABLE IF NOT EXISTS inbound_unmatched (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      to_address TEXT,
      from_address TEXT,
      subject TEXT,
      received_at TIMESTAMPTZ DEFAULT NOW(),
      raw_payload JSONB,
      reason TEXT
    )
  `);
  results.push('inbound_unmatched table created');

  // Verify all tables exist
  const tablesCheck = await db.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('conversations','conversation_messages','agency_email_log','inbound_unmatched')
    ORDER BY table_name
  `);

  // Verify new columns on subaccount_email_domains
  const colsCheck = await db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'subaccount_email_domains'
      AND column_name IN ('inbound_subdomain','inbound_status','inbound_mx_target','inbound_verified_at')
    ORDER BY column_name
  `);

  return {
    operations: results,
    tables_present: tablesCheck.rows.map(r => r.table_name),
    inbound_columns_present: colsCheck.rows.map(r => r.column_name)
  };
};
