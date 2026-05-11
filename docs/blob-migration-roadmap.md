# Blob Migration Roadmap

Last updated: May 11, 2026

This doc captures the remaining `subaccount_data.data` blob keys that should move to dedicated RDS tables, organized by priority. Each item includes target schema, dependencies, effort estimate, risk, and recommended order.

## Current State (after Pass #4 scrub)

The `subaccount_data` blob contains 17 top-level keys. They split into two groups:

### TIER 2: Should move to RDS (10 items)

Money-related (Payment Policy violation) and PHI items still in JSONB.

### TIER 3: Stay in blob (7 items)

Settings and UI state. JSONB is appropriate for these.

| Key | Reason to stay |
|---|---|
| settings | Workspace config (timezone, business hours, branding) |
| paySettings | Tax + tip + fee config |
| tags | Free-form contact labels |
| readNotifs | UI state (which notifications user dismissed) |
| customFields | Schema definitions |
| customFieldCategories | Schema definitions |
| serviceResources | DEAD, dropped in Pass #4 |

---

## TIER 2 Migration Plan

### Recommended Execution Order

Money first (Payment Policy compliance is the highest stake), then PHI (HIPAA risk), then operational. Smallest items first within each group to build momentum.

### 1. productCategories (15 min) — START HERE

**Current state:** 6 categories in blob, 115 bytes.

**Target schema:**
```sql
CREATE TABLE product_categories (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_prodcat_sub ON product_categories(subaccount_id);
```

**Lambdas needed:**
- product-categories-list (GET)
- product-categories-upsert (POST)
- product-categories-delete (DELETE)

**Dependencies:** None. Standalone.

**Frontend changes:** Replace `db.productCategories` reads with API calls. Editor UI in Settings or Products tab.

**Risk:** Low. Small data, simple schema.

**Effort:** 15-30 min.

---

### 2. sessionPackTemplates (30 min)

**Current state:** 1 template in blob, 360 bytes.

**Target schema:**
```sql
CREATE TABLE session_pack_templates (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  variation_id TEXT REFERENCES service_variations(id) ON DELETE SET NULL,
  sessions_count INTEGER NOT NULL,
  price NUMERIC(10,2) NOT NULL DEFAULT 0,
  taxable BOOLEAN NOT NULL DEFAULT TRUE,
  expires_days INTEGER,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_sptpl_sub ON session_pack_templates(subaccount_id);
```

**Lambdas needed:** list, upsert, delete.

**Dependencies:** None. Standalone.

**Frontend changes:** Replace `db.sessionPackTemplates` reads. Editor UI in service settings.

**Risk:** Low. Few records, simple.

**Effort:** 30 min.

---

### 3. products (1 hour)

**Current state:** 1 product in blob, 564 bytes.

**Target schema:**
```sql
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES product_categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC(10,2) NOT NULL DEFAULT 0,
  cost NUMERIC(10,2),
  sku TEXT,
  taxable BOOLEAN NOT NULL DEFAULT TRUE,
  track_inventory BOOLEAN NOT NULL DEFAULT FALSE,
  stock_quantity INTEGER,
  image_url TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_products_sub ON products(subaccount_id);
CREATE INDEX idx_products_cat ON products(category_id);
```

**Lambdas needed:** list, upsert, delete.

**Dependencies:** product_categories (do that first for the FK).

**Frontend changes:** Replace `db.products` reads. POS product picker + product editor.

**Risk:** Low. Inventory tracking is optional.

**Effort:** 1 hour.

---

### 4. tasks (1.5 hours)

**Current state:** 2 tasks in blob, 609 bytes.

**Target schema:**
```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  assigned_to UUID REFERENCES subaccount_users(id) ON DELETE SET NULL,
  contact_id TEXT,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','completed','cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES subaccount_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tasks_sub_status ON tasks(subaccount_id, status);
CREATE INDEX idx_tasks_assigned ON tasks(assigned_to);
CREATE INDEX idx_tasks_contact ON tasks(contact_id);
```

**Lambdas needed:** list, upsert, delete, complete.

**Dependencies:** None.

**Frontend changes:** Tasks tab. Replace `db.tasks` reads. Add assigned-to filter.

**Risk:** Low. Simple operational data.

**Effort:** 1.5 hours.

---

### 5. coupons (2 hours)

**Current state:** 1 coupon in blob, 868 bytes.

**Target schema:**
```sql
CREATE TABLE coupons (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('flat','pct')),
  discount_value NUMERIC(10,2) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ,
  usage_limit INTEGER,
  usage_count INTEGER NOT NULL DEFAULT 0,
  max_per_customer INTEGER,
  applies_to JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(subaccount_id, code)
);
CREATE INDEX idx_coupons_sub_active ON coupons(subaccount_id, active);

CREATE TABLE coupon_usage_log (
  id TEXT PRIMARY KEY,
  coupon_id TEXT NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  contact_id TEXT,
  payment_id TEXT,
  amount_saved NUMERIC(10,2) NOT NULL,
  staff_id UUID REFERENCES subaccount_users(id) ON DELETE SET NULL,
  used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_couponusage_coupon ON coupon_usage_log(coupon_id);
CREATE INDEX idx_couponusage_payment ON coupon_usage_log(payment_id);
```

**Lambdas needed:** list, upsert, delete, validate (for booking widget).

**Dependencies:** None for schema, but bookin/POS flows need updating to use the new endpoints.

**Frontend changes:** Coupon editor in Settings. POS coupon application. Payment Policy section on coupon validation.

**Risk:** Medium. Booking widget and POS both use coupons. Need careful test of validate flow.

**Effort:** 2 hours.

---

### 6. sessionPacks (2 hours)

**Current state:** 3 pack sales in blob, 2,892 bytes. These are MONEY records (purchased session packs).

**Target schema:**
```sql
CREATE TABLE session_packs (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  template_id TEXT REFERENCES session_pack_templates(id) ON DELETE SET NULL,
  contact_id TEXT NOT NULL,
  service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  variation_id TEXT REFERENCES service_variations(id) ON DELETE SET NULL,
  payment_id TEXT REFERENCES payments(id) ON DELETE SET NULL,
  total_sessions INTEGER NOT NULL,
  sessions_remaining INTEGER NOT NULL,
  price_paid NUMERIC(10,2) NOT NULL,
  expires_at DATE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','depleted','expired','refunded','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_sesspack_contact ON session_packs(contact_id);
CREATE INDEX idx_sesspack_status ON session_packs(subaccount_id, status);
CREATE INDEX idx_sesspack_payment ON session_packs(payment_id);

CREATE TABLE session_pack_redemptions (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES session_packs(id) ON DELETE RESTRICT,
  appointment_id TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  redeemed_by UUID REFERENCES subaccount_users(id) ON DELETE SET NULL
);
CREATE INDEX idx_packred_pack ON session_pack_redemptions(pack_id);
CREATE INDEX idx_packred_appt ON session_pack_redemptions(appointment_id);
```

**Lambdas needed:** purchase, list, redeem, refund, cancel.

**Dependencies:** session_pack_templates (#2 above).

**Frontend changes:** POS purchase flow. Appointment redemption flow. Customer pack history.

**Risk:** High. Money + appointment linkage. Refund flow must restore unused sessions.

**Effort:** 2 hours minimum. Possibly 3.

---

### 7. giftCards (2-3 hours)

**Current state:** 9 gift cards in blob, 6,192 bytes. MONEY records.

**Target schema:**
```sql
CREATE TABLE gift_cards (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  initial_value NUMERIC(10,2) NOT NULL,
  balance NUMERIC(10,2) NOT NULL,
  issued_to_contact_id TEXT,
  issued_to_name TEXT,
  issued_to_email TEXT,
  purchaser_contact_id TEXT,
  purchase_payment_id TEXT REFERENCES payments(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','partial','redeemed','refunded','cancelled')),
  expires_at DATE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(subaccount_id, code)
);
CREATE INDEX idx_gc_sub_status ON gift_cards(subaccount_id, status);
CREATE INDEX idx_gc_code ON gift_cards(code);

CREATE TABLE gift_card_log (
  id TEXT PRIMARY KEY,
  gift_card_id TEXT NOT NULL REFERENCES gift_cards(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('issue','redeem','refund','adjust')),
  amount NUMERIC(10,2) NOT NULL,
  balance_after NUMERIC(10,2) NOT NULL,
  contact_id TEXT,
  payment_id TEXT,
  staff_id UUID REFERENCES subaccount_users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_gclog_card ON gift_card_log(gift_card_id);
CREATE INDEX idx_gclog_payment ON gift_card_log(payment_id);
```

**Lambdas needed:** purchase, list, lookup-by-code, redeem, refund, adjust.

**Dependencies:** None.

**Frontend changes:** GC purchase UI, GC redemption in POS, GC balance lookup.

**Risk:** High. Money. Per Payment Policy: "Failed payments must NOT drain the GC. Drain GC only after remainder succeeds OR is non-card."

**Effort:** 2-3 hours.

---

### 8. giftCardProducts (1 hour) — URGENT BLOAT FIX

**Current state:** 2 products in blob, **312,856 bytes (312KB!)**. Probably has inline base64 images.

**Target schema:**
```sql
CREATE TABLE gift_card_products (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  preset_amounts JSONB NOT NULL DEFAULT '[25,50,100]'::jsonb,
  allow_custom_amount BOOLEAN NOT NULL DEFAULT TRUE,
  custom_min NUMERIC(10,2),
  custom_max NUMERIC(10,2),
  image_url TEXT,  -- NOT inline base64. Use the media_files table / S3.
  expires_days INTEGER,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_gcprod_sub ON gift_card_products(subaccount_id);
```

**Critical:** Move inline image data OUT. Images upload to S3, store URL only.

**Lambdas needed:** list, upsert, delete.

**Dependencies:** Media upload flow already exists.

**Risk:** Medium. Need to migrate inline images to S3 during migration.

**Effort:** 1 hour (assuming image migration script).

---

### 9. forms (1 hour)

**Current state:** 1 form definition in blob, 898 bytes.

**Target schema:**
```sql
CREATE TABLE intake_forms (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_forms_sub ON intake_forms(subaccount_id);
```

**Lambdas needed:** list, upsert, delete.

**Dependencies:** None. Booking widgets reference by ID.

**Risk:** Low.

**Effort:** 1 hour.

---

### 10. formSubmissions (1.5 hours) — PHI

**Current state:** 0 submissions in blob (8 bytes empty). PHI when populated.

**Target schema:**
```sql
CREATE TABLE form_submissions (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  form_id TEXT REFERENCES intake_forms(id) ON DELETE SET NULL,
  contact_id TEXT,
  appointment_id TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  responses JSONB NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address TEXT,
  source TEXT
);
CREATE INDEX idx_formsub_form ON form_submissions(form_id);
CREATE INDEX idx_formsub_contact ON form_submissions(contact_id);
CREATE INDEX idx_formsub_appt ON form_submissions(appointment_id);
```

**Lambdas needed:** list (admin only with audit), submit (public for booking widgets).

**Dependencies:** intake_forms (#9).

**Risk:** Medium. PHI requires audit logging on every read.

**Effort:** 1.5 hours.

---

### 11. contacts (3+ hours) — PHI, HIGHEST STAKES

**Current state:** 16 contacts in blob, 11,150 bytes. PHI. Patient records.

**This is the biggest one and deserves its own session.** Don't tack it onto another migration.

**Considerations:**
- contacts are referenced everywhere: appointments, payments, gift_cards, session_packs, tasks, form_submissions, audit_log
- Once contacts move to a table, every cross-reference becomes a real FK relationship
- Patient search/filter needs proper indexes
- HIPAA Right of Access export gets easier when contacts are queryable
- Custom fields need their own table or JSONB column on contacts

**Target schema (high level):**
```sql
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  subaccount_id TEXT NOT NULL REFERENCES subaccounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address JSONB,
  date_of_birth DATE,
  notes TEXT,
  tags JSONB DEFAULT '[]'::jsonb,
  custom_fields JSONB DEFAULT '{}'::jsonb,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT,
  timezone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_contacts_sub_archived ON contacts(subaccount_id, archived);
CREATE INDEX idx_contacts_email ON contacts(subaccount_id, lower(email));
CREATE INDEX idx_contacts_phone ON contacts(subaccount_id, phone);
CREATE INDEX idx_contacts_name ON contacts(subaccount_id, lower(name));
```

**Lambdas needed:** list, upsert, archive, delete, search (with PHI audit on every read).

**Dependencies:** Updates needed in: appointments (add FK eventually), payments (FK), gift_cards (FK), session_packs (FK), tasks (FK), form_submissions (FK), audit_log enrichment.

**Frontend changes:** Replace every `db.contacts` read (55+ refs in index.html). Update contact picker. Update CRM tab. Update HIPAA Right of Access export.

**Risk:** Very high. Touches everything. Schedule a dedicated session with no other work in flight.

**Effort:** 3-5 hours. Possibly 6 with FK additions across other tables.

---

## Sequencing Notes

**Recommended order (smallest stakes to largest):**

1. productCategories (15 min) — gets you the pattern
2. sessionPackTemplates (30 min) — same pattern
3. products (1 hour) — depends on #1
4. tasks (1.5 hours) — independent
5. forms (1 hour) — independent
6. formSubmissions (1.5 hours) — depends on #5
7. giftCardProducts (1 hour) — fixes bloat
8. coupons (2 hours)
9. giftCards (2-3 hours)
10. sessionPacks (2 hours) — depends on #2
11. contacts (3-5 hours) — dedicated session

**Total estimated effort:** 16-20 hours.

**Recommended cadence:** One migration per session, smallest first to build the pattern. The first three should fit in a single session and establish the template.

## Migration Pattern (apply consistently)

For each migration:

1. Schema: write SQL migration (idempotent ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS)
2. Data: write one-shot copy Lambda blob → table
3. Lambdas: build list, upsert, delete (use `requireSubaccountAuth`, `wrap`, `logAudit`)
4. API Gateway: routes + integrations + permissions
5. Frontend: replace `db.X` reads with API calls, mutations through new endpoints
6. Update `data-save.js` STRIPPED_TOP_LEVEL to include the moved key
7. Run scrub to remove from existing blob
8. Verify in production
9. Update this doc to mark item DONE

## Audit Log Requirements (PHI items)

For contacts and formSubmissions:
- Read endpoints: log every fetch with target_id, target_type
- Write endpoints: log create/update with changed fields
- Use `logAudit({action: 'subaccount.contact.view', targetType: 'contact', targetId, metadata: {...}})`
- Retention: 6 years per HIPAA

## What NOT to Do

- Don't migrate in batch. Pick one item, finish it end-to-end, test, then move on.
- Don't skip the strip update + scrub. The blob WILL drift if data-save doesn't strip.
- Don't combine migrations to save time. Each one is its own commit, deployable independently.
- Don't put PHI in JSONB columns when relational makes sense. The `responses` field on form_submissions IS a reasonable JSONB use because schemas vary; the contacts table is NOT.

## Audit History

- May 11, 2026: Pass #4 audit, plan written. TIER 4 + TIER 1 executed. TIER 2 pending.
