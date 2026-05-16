-- Create journeys, journey_stages, journey_cards tables for the Journeys feature
-- Kanban-style funnel tracking, per MySpark-Journeys-Spec.md
-- Cards may carry PHI (lead_name, lead_email, lead_phone, contact references)
-- Cards carry money values per Payment Policy (NUMERIC, never FLOAT)
-- Retention: cascade with subaccount

-- ============================================================
-- 1. journeys
-- ============================================================

CREATE TABLE IF NOT EXISTS journeys (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (LENGTH(name) > 0),
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  color TEXT NOT NULL DEFAULT '#6b21ea',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_journeys_subaccount_active
  ON journeys(subaccount_id, sort_order)
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_journeys_subaccount_all
  ON journeys(subaccount_id, sort_order);

COMMENT ON TABLE journeys IS
  'Kanban funnel containers (sales pipelines, patient lifecycle trackers). All-staff visibility per subaccount in Stage 1.';
COMMENT ON COLUMN journeys.color IS
  'Hex color for journey identity in UI. Defaults to brand purple (--purple token).';

-- ============================================================
-- 2. journey_stages
-- ============================================================

CREATE TABLE IF NOT EXISTS journey_stages (
  id TEXT PRIMARY KEY,
  journey_id TEXT NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (LENGTH(name) > 0),
  stage_type TEXT NOT NULL DEFAULT 'normal'
    CHECK (stage_type IN ('normal', 'won', 'lost')),
  color TEXT NOT NULL DEFAULT '#6b21ea',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_journey_stages_journey
  ON journey_stages(journey_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_journey_stages_subaccount
  ON journey_stages(subaccount_id);

COMMENT ON TABLE journey_stages IS
  'Columns within a journey. stage_type drives card.status auto-flip on drag (won and lost stages).';
COMMENT ON COLUMN journey_stages.stage_type IS
  'Drives card.status when a card is moved into this stage. normal leaves status alone; won/lost auto-flip card.status and timestamp.';

-- ============================================================
-- 3. journey_cards
-- ============================================================

CREATE TABLE IF NOT EXISTS journey_cards (
  id TEXT PRIMARY KEY,
  journey_id TEXT NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL REFERENCES journey_stages(id) ON DELETE RESTRICT,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,

  -- Identity / linkage
  title TEXT NOT NULL CHECK (LENGTH(title) > 0),
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  appointment_id TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  assigned_staff_id UUID REFERENCES subaccount_users(id) ON DELETE SET NULL,

  -- Raw lead info (used when contact_id is null)
  lead_name TEXT,
  lead_email TEXT,
  lead_phone TEXT,

  -- Money (per Payment Policy: NUMERIC, never FLOAT)
  value NUMERIC(10,2) NOT NULL DEFAULT 0,

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'won', 'lost')),
  position INTEGER NOT NULL DEFAULT 0,
  archived BOOLEAN NOT NULL DEFAULT FALSE,

  -- Context
  notes TEXT,
  source TEXT,
  expected_close_date DATE,
  won_at TIMESTAMPTZ,
  lost_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_journey_cards_stage_position
  ON journey_cards(stage_id, position)
  WHERE archived = FALSE;

CREATE INDEX IF NOT EXISTS idx_journey_cards_journey_active
  ON journey_cards(journey_id, status)
  WHERE archived = FALSE;

CREATE INDEX IF NOT EXISTS idx_journey_cards_subaccount
  ON journey_cards(subaccount_id);

CREATE INDEX IF NOT EXISTS idx_journey_cards_contact
  ON journey_cards(contact_id)
  WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_journey_cards_appointment
  ON journey_cards(appointment_id)
  WHERE appointment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_journey_cards_won_at
  ON journey_cards(subaccount_id, won_at DESC)
  WHERE status = 'won' AND archived = FALSE;

COMMENT ON TABLE journey_cards IS
  'Individual tiles on a kanban board. May reference a contact (preferred) or hold raw lead info. Value field carries money per Payment Policy.';
COMMENT ON COLUMN journey_cards.value IS
  'Potential or won revenue tied to this card. Always NUMERIC(10,2), never FLOAT. Displayed via fmt$() in frontend.';
COMMENT ON COLUMN journey_cards.position IS
  'Order within stage. Recompute on every move to avoid float-fraction drift. Stage 1: simple integer reflow.';
COMMENT ON COLUMN journey_cards.contact_id IS
  'Preferred linkage to contacts table. When null, lead_name/email/phone hold raw lead info until promoted to a contact.';
