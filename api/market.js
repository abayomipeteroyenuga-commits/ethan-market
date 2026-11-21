'use strict';

const crypto = require('node:crypto');
const { Pool } = require('pg');

// One-time bootstrap code is checked by its SHA-256 digest, never stored in plaintext.
const OWNER_SETUP_HASH = Buffer.from([
  0x7f, 0x11, 0x07, 0x74, 0x7f, 0xdc, 0x49, 0xf4,
  0xec, 0x16, 0x1e, 0x83, 0xc3, 0xf1, 0xbd, 0x89,
  0x32, 0x86, 0x29, 0x30, 0x72, 0x7f, 0xcc, 0x56,
  0x97, 0x98, 0xb1, 0x14, 0x50, 0x00, 0x2a, 0x00
]).toString('hex');

const COOKIE = 'ethan_market_session';
const SESSION_DAYS = 30;

function fieldKey() {
  const raw=String(process.env.MARKET_FIELD_ENCRYPTION_KEY||'');
  if(!/^[a-f0-9]{64}$/i.test(raw)) return null;
  return Buffer.from(raw,'hex');
}
function encryptField(value) {
  const text=String(value||''); if(!text) return '';
  if(text.startsWith('enc:v1:')) return text;
  const key=fieldKey(); if(!key) throw new HttpError(503,'Sensitive payout fields are not configured for encryption.');
  const iv=crypto.randomBytes(12); const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const encrypted=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);
  return 'enc:v1:'+iv.toString('hex')+':'+cipher.getAuthTag().toString('hex')+':'+encrypted.toString('hex');
}
function decryptField(value) {
  const text=String(value||''); if(!text) return '';
  if(!text.startsWith('enc:v1:')) return text;
  const key=fieldKey(); if(!key) return '••••';
  const parts=text.split(':'); if(parts.length!==5) return '••••';
  try { const iv=Buffer.from(parts[2],'hex'); const tag=Buffer.from(parts[3],'hex'); const data=Buffer.from(parts[4],'hex'); const decipher=crypto.createDecipheriv('aes-256-gcm',key,iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8'); } catch { return '••••'; }
}
const MAX_BODY = 256 * 1024;
let pool;
let schemaPromise;

function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) throw new HttpError(503, 'Marketplace database is not configured.');
  const parsed = new URL(process.env.DATABASE_URL);
  parsed.searchParams.delete('channel_binding'); parsed.searchParams.delete('sslmode');
  pool = new Pool({
    connectionString: parsed.toString(),
    ssl: { rejectUnauthorized: true },
    max: 4,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    application_name: 'ethan-market'
  });
  return pool;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const schema = [
  `CREATE TABLE IF NOT EXISTS market_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), full_name text NOT NULL, email text NOT NULL,
    phone text, password_hash text NOT NULL, role text NOT NULL DEFAULT 'buyer'
      CHECK (role IN ('buyer','seller','admin','super_admin')),
    is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS market_users_email_uq ON market_users (lower(email))`,
  `CREATE TABLE IF NOT EXISTS market_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES market_users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS market_sessions_user_idx ON market_sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS market_categories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE, slug text NOT NULL UNIQUE,
    icon text NOT NULL DEFAULT '▦', sort_order int NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true
  )`,
  `CREATE TABLE IF NOT EXISTS market_sellers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE REFERENCES market_users(id) ON DELETE CASCADE,
    store_name text NOT NULL, slug text NOT NULL UNIQUE, description text NOT NULL DEFAULT '', phone text NOT NULL DEFAULT '',
    whatsapp text NOT NULL DEFAULT '', business_type text NOT NULL DEFAULT 'individual', city text NOT NULL DEFAULT '',
    state text NOT NULL DEFAULT '', seller_status text NOT NULL DEFAULT 'pending' CHECK (seller_status IN ('pending','approved','rejected','suspended')),
    bank_name text NOT NULL DEFAULT '', bank_code text NOT NULL DEFAULT '', account_number text NOT NULL DEFAULT '',
    account_name text NOT NULL DEFAULT '', commission_bps int NOT NULL DEFAULT 1000 CHECK (commission_bps BETWEEN 0 AND 5000),
    paystack_subaccount_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS market_products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_id uuid NOT NULL REFERENCES market_sellers(id),
    category_id uuid REFERENCES market_categories(id), name text NOT NULL, slug text NOT NULL,
    description text NOT NULL DEFAULT '', product_type text NOT NULL DEFAULT 'physical' CHECK (product_type IN ('physical','digital')),
    price_kobo bigint NOT NULL CHECK (price_kobo >= 100), compare_at_kobo bigint CHECK (compare_at_kobo IS NULL OR compare_at_kobo >= price_kobo),
    image_url text NOT NULL DEFAULT '', sku text NOT NULL DEFAULT '', stock_qty int NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
    digital_delivery_url text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'pending' CHECK (status IN ('draft','pending','active','rejected','archived')),
    featured boolean NOT NULL DEFAULT false, views int NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(seller_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS market_products_public_idx ON market_products(status, category_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS market_products_seller_idx ON market_products(seller_id, status)`,
  `CREATE TABLE IF NOT EXISTS market_product_variants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id uuid NOT NULL REFERENCES market_products(id) ON DELETE CASCADE,
    seller_id uuid NOT NULL REFERENCES market_sellers(id) ON DELETE CASCADE,
    label text NOT NULL, sku text NOT NULL DEFAULT '',
    price_kobo bigint CHECK (price_kobo IS NULL OR price_kobo >= 100),
    stock_qty int NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS market_product_variants_product_idx ON market_product_variants(product_id,is_active)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS market_product_variants_label_uq ON market_product_variants(product_id,lower(label)) WHERE is_active=true`,
  `CREATE INDEX IF NOT EXISTS market_product_variants_seller_idx ON market_product_variants(seller_id,product_id,is_active)`,

  `CREATE TABLE IF NOT EXISTS market_orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_number text NOT NULL UNIQUE,
    buyer_id uuid NOT NULL REFERENCES market_users(id), buyer_email text NOT NULL,
    recipient_name text NOT NULL, phone text NOT NULL, subtotal_kobo bigint NOT NULL, shipping_kobo bigint NOT NULL DEFAULT 0,
    total_kobo bigint NOT NULL, currency text NOT NULL DEFAULT 'NGN', payment_provider text NOT NULL DEFAULT 'paystack', payment_reference text, payment_status text NOT NULL DEFAULT 'pending'
      CHECK (payment_status IN ('pending','paid','failed','refunded','reversed')),
    status text NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment','processing','partially_dispatched','dispatched','delivered','cancelled','refunded')),
    paystack_reference text UNIQUE, shipping_address jsonb NOT NULL DEFAULT '{}'::jsonb, buyer_note text NOT NULL DEFAULT '',
    payment_verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE market_orders ADD COLUMN IF NOT EXISTS payment_provider text NOT NULL DEFAULT 'paystack'`,
  `ALTER TABLE market_orders ADD COLUMN IF NOT EXISTS payment_reference text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS market_orders_payment_reference_uq ON market_orders(payment_reference) WHERE payment_reference IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS market_orders_buyer_idx ON market_orders(buyer_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS market_orders_status_idx ON market_orders(status, payment_status, created_at DESC)`,
  `ALTER TABLE market_orders ADD COLUMN IF NOT EXISTS discount_kobo bigint NOT NULL DEFAULT 0`,
  `ALTER TABLE market_orders ADD COLUMN IF NOT EXISTS promo_code text NOT NULL DEFAULT ''`,
  `ALTER TABLE market_orders ADD COLUMN IF NOT EXISTS campaign_slug text NOT NULL DEFAULT ''`,
  `ALTER TABLE market_orders ADD COLUMN IF NOT EXISTS affiliate_user_id uuid REFERENCES market_users(id)`,
  `CREATE TABLE IF NOT EXISTS market_growth_profiles (
    user_id uuid PRIMARY KEY REFERENCES market_users(id) ON DELETE CASCADE,
    referral_code text NOT NULL UNIQUE,
    affiliate_status text NOT NULL DEFAULT 'none' CHECK (affiliate_status IN ('none','pending','approved','paused')),
    affiliate_commission_bps int NOT NULL DEFAULT 0 CHECK (affiliate_commission_bps BETWEEN 0 AND 5000),
    first_campaign_slug text NOT NULL DEFAULT '',
    first_source text NOT NULL DEFAULT '',
    first_medium text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS market_growth_attributions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_user_id uuid NOT NULL REFERENCES market_users(id) ON DELETE CASCADE,
    referred_user_id uuid NOT NULL UNIQUE REFERENCES market_users(id) ON DELETE CASCADE,
    referral_code text NOT NULL,
    status text NOT NULL DEFAULT 'signed_up' CHECK (status IN ('signed_up','first_order','seller_approved')),
    first_order_id uuid REFERENCES market_orders(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    first_order_at timestamptz,
    seller_approved_at timestamptz,
    CHECK (referrer_user_id <> referred_user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS market_growth_attributions_referrer_idx ON market_growth_attributions(referrer_user_id,created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS market_growth_campaigns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    slug text NOT NULL UNIQUE,
    source text NOT NULL DEFAULT '',
    medium text NOT NULL DEFAULT '',
    budget_kobo bigint NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed')),
    starts_at timestamptz,
    ends_at timestamptz,
    created_by uuid REFERENCES market_users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS market_promo_codes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code text NOT NULL UNIQUE,
    discount_bps int NOT NULL CHECK (discount_bps BETWEEN 1 AND 10000),
    max_discount_kobo bigint NOT NULL DEFAULT 0,
    min_subtotal_kobo bigint NOT NULL DEFAULT 0,
    max_redemptions int,
    active boolean NOT NULL DEFAULT true,
    campaign_id uuid REFERENCES market_growth_campaigns(id) ON DELETE SET NULL,
    starts_at timestamptz,
    ends_at timestamptz,
    created_by uuid REFERENCES market_users(id),
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS market_promo_redemptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    promo_id uuid NOT NULL REFERENCES market_promo_codes(id),
    order_id uuid NOT NULL UNIQUE REFERENCES market_orders(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES market_users(id),
    discount_kobo bigint NOT NULL,
    status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','redeemed','expired','failed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    redeemed_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS market_promo_redemptions_usage_idx ON market_promo_redemptions(promo_id,status,created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS market_affiliate_conversions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    affiliate_user_id uuid NOT NULL REFERENCES market_users(id),
    order_id uuid NOT NULL UNIQUE REFERENCES market_orders(id) ON DELETE CASCADE,
    referral_code text NOT NULL,
    sale_kobo bigint NOT NULL,
    marketplace_fee_kobo bigint NOT NULL,
    commission_kobo bigint NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','void')),
    payout_reference text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    paid_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS market_affiliate_conversions_affiliate_idx ON market_affiliate_conversions(affiliate_user_id,status,created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS market_growth_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type text NOT NULL,
    user_id uuid REFERENCES market_users(id) ON DELETE SET NULL,
    order_id uuid REFERENCES market_orders(id) ON DELETE SET NULL,
    campaign_slug text NOT NULL DEFAULT '',
    source text NOT NULL DEFAULT '',
    medium text NOT NULL DEFAULT '',
    referral_code text NOT NULL DEFAULT '',
    path text NOT NULL DEFAULT '',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS market_growth_events_campaign_idx ON market_growth_events(campaign_slug,event_type,created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS market_order_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES market_orders(id) ON DELETE CASCADE,
    product_id uuid REFERENCES market_products(id), seller_id uuid NOT NULL REFERENCES market_sellers(id),
    product_name text NOT NULL, product_type text NOT NULL CHECK (product_type IN ('physical','digital')),
    quantity int NOT NULL CHECK (quantity > 0), unit_price_kobo bigint NOT NULL, commission_kobo bigint NOT NULL DEFAULT 0,
    seller_net_kobo bigint NOT NULL DEFAULT 0, fulfillment_status text NOT NULL DEFAULT 'unfulfilled'
      CHECK (fulfillment_status IN ('unfulfilled','processing','dispatched','delivered','cancelled')),
    tracking_number text NOT NULL DEFAULT '', tracking_carrier text NOT NULL DEFAULT '', digital_delivery_url text NOT NULL DEFAULT '',
    stock_deducted boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE market_order_items ADD COLUMN IF NOT EXISTS variant_id uuid REFERENCES market_product_variants(id) ON DELETE SET NULL`,
  `ALTER TABLE market_order_items ADD COLUMN IF NOT EXISTS variant_label text NOT NULL DEFAULT ''`,
  `ALTER TABLE market_order_items ADD COLUMN IF NOT EXISTS variant_sku text NOT NULL DEFAULT ''`,
  `CREATE INDEX IF NOT EXISTS market_order_items_variant_idx ON market_order_items(variant_id,created_at DESC) WHERE variant_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS market_order_items_seller_idx ON market_order_items(seller_id, fulfillment_status, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS market_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES market_orders(id),
    provider text NOT NULL DEFAULT 'paystack', reference text NOT NULL UNIQUE, amount_kobo bigint NOT NULL,
    currency text NOT NULL DEFAULT 'NGN', status text NOT NULL DEFAULT 'pending', gateway_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(), verified_at timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS market_payouts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_item_id uuid NOT NULL UNIQUE REFERENCES market_order_items(id),
    order_id uuid NOT NULL REFERENCES market_orders(id), seller_id uuid NOT NULL REFERENCES market_sellers(id),
    gross_kobo bigint NOT NULL, commission_kobo bigint NOT NULL, net_kobo bigint NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','held','reversed')),
    payout_reference text NOT NULL DEFAULT '', paid_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS market_payouts_status_idx ON market_payouts(status, created_at DESC)`,
  `ALTER TABLE market_order_items ADD COLUMN IF NOT EXISTS delivered_at timestamptz`,
  `ALTER TABLE market_order_items ADD COLUMN IF NOT EXISTS buyer_confirmed_at timestamptz`,
  `ALTER TABLE market_payouts ADD COLUMN IF NOT EXISTS eligible_at timestamptz`,
  `ALTER TABLE market_payouts ADD COLUMN IF NOT EXISTS hold_reason text NOT NULL DEFAULT ''`,
  `CREATE TABLE IF NOT EXISTS market_disputes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_item_id uuid NOT NULL UNIQUE REFERENCES market_order_items(id),
    order_id uuid NOT NULL REFERENCES market_orders(id),
    buyer_id uuid NOT NULL REFERENCES market_users(id),
    seller_id uuid NOT NULL REFERENCES market_sellers(id),
    reason text NOT NULL CHECK (reason IN ('item_not_received','damaged','not_as_described','wrong_item','digital_access','other')),
    details text NOT NULL,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','under_review','resolved_seller','resolved_buyer')),
    seller_response text NOT NULL DEFAULT '',
    resolution_notes text NOT NULL DEFAULT '',
    resolution_reference text NOT NULL DEFAULT '',
    opened_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    resolved_by uuid REFERENCES market_users(id),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS market_disputes_status_idx ON market_disputes(status,opened_at DESC)`,
  `CREATE INDEX IF NOT EXISTS market_disputes_seller_idx ON market_disputes(seller_id,status,opened_at DESC)`,
  `CREATE TABLE IF NOT EXISTS market_product_questions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id uuid NOT NULL REFERENCES market_products(id) ON DELETE CASCADE,
    asker_id uuid NOT NULL REFERENCES market_users(id) ON DELETE CASCADE,
    question text NOT NULL CHECK (char_length(question) BETWEEN 10 AND 1000),
    answer text NOT NULL DEFAULT '',
    answered_by uuid REFERENCES market_users(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','hidden')),
    created_at timestamptz NOT NULL DEFAULT now(), answered_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS market_product_questions_public_idx ON market_product_questions(product_id,status,created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS market_product_questions_asker_idx ON market_product_questions(asker_id,created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS market_conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_id uuid NOT NULL REFERENCES market_users(id) ON DELETE CASCADE,
    seller_user_id uuid NOT NULL REFERENCES market_users(id) ON DELETE CASCADE,
    context_type text NOT NULL CHECK (context_type IN ('product','order')),
    product_id uuid REFERENCES market_products(id) ON DELETE SET NULL,
    order_item_id uuid REFERENCES market_order_items(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (buyer_id <> seller_user_id),
    CHECK ((context_type='product' AND product_id IS NOT NULL AND order_item_id IS NULL)
        OR (context_type='order' AND product_id IS NULL AND order_item_id IS NOT NULL))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS market_conversations_product_uq ON market_conversations(buyer_id,seller_user_id,product_id) WHERE context_type='product'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS market_conversations_order_uq ON market_conversations(order_item_id) WHERE context_type='order'`,
  `CREATE INDEX IF NOT EXISTS market_conversations_buyer_idx ON market_conversations(buyer_id,updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS market_conversations_seller_idx ON market_conversations(seller_user_id,updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS market_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES market_conversations(id) ON DELETE CASCADE,
    sender_id uuid NOT NULL REFERENCES market_users(id) ON DELETE CASCADE,
    body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
    created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS market_messages_thread_idx ON market_messages(conversation_id,created_at ASC)`,
  `CREATE INDEX IF NOT EXISTS market_messages_unread_idx ON market_messages(conversation_id,read_at) WHERE read_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS market_delivery_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_item_id uuid NOT NULL REFERENCES market_order_items(id) ON DELETE CASCADE,
    status text NOT NULL CHECK (status IN ('processing','dispatched','delivered','cancelled')),
    note text NOT NULL DEFAULT '', carrier text NOT NULL DEFAULT '', tracking_number text NOT NULL DEFAULT '',
    actor_id uuid REFERENCES market_users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS market_delivery_events_item_idx ON market_delivery_events(order_item_id,created_at ASC)`,
  `CREATE TABLE IF NOT EXISTS market_notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES market_users(id) ON DELETE CASCADE,
    type text NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    target_tab text NOT NULL DEFAULT 'orders',
    dedupe_key text NOT NULL DEFAULT '',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    read_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS market_notifications_user_idx ON market_notifications(user_id,created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS market_notifications_unread_idx ON market_notifications(user_id,created_at DESC) WHERE read_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS market_notifications_dedupe_uq ON market_notifications(user_id,dedupe_key) WHERE dedupe_key <> ''`,
  `CREATE TABLE IF NOT EXISTS market_wishlists (
    user_id uuid NOT NULL REFERENCES market_users(id) ON DELETE CASCADE,
    product_id uuid NOT NULL REFERENCES market_products(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id, product_id)
  )`,
  `CREATE TABLE IF NOT EXISTS market_reviews (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL REFERENCES market_products(id) ON DELETE CASCADE,
    order_id uuid NOT NULL REFERENCES market_orders(id), buyer_id uuid NOT NULL REFERENCES market_users(id),
    rating int NOT NULL CHECK (rating BETWEEN 1 AND 5), review_text text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(product_id, order_id, buyer_id)
  )`,
  `CREATE TABLE IF NOT EXISTS market_settings (
    key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS market_audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid REFERENCES market_users(id),
    action text NOT NULL, entity_type text NOT NULL DEFAULT '', entity_id text NOT NULL DEFAULT '',
    details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS market_rate_limits (
    key text NOT NULL, action text NOT NULL, window_start timestamptz NOT NULL DEFAULT now(),
    attempts int NOT NULL DEFAULT 1, PRIMARY KEY(key, action)
  )`,
  `INSERT INTO market_categories(name,slug,icon,sort_order) VALUES
    ('Electronics','electronics','⌁',1),('Fashion','fashion','◈',2),('Home & Living','home-living','⌂',3),
    ('Beauty & Wellness','beauty-wellness','✦',4),('Food & Groceries','food-groceries','◉',5),
    ('Digital Products','digital-products','▣',6),('Books & Learning','books-learning','▤',7),
    ('Business & Office','business-office','▧',8),('Sports & Outdoors','sports-outdoors','◎',9)
    ON CONFLICT(slug) DO NOTHING`,
  `INSERT INTO market_settings(key,value) VALUES
    ('commission_bps','1000'::jsonb),('physical_shipping_kobo','200000'::jsonb),('marketplace_name','"ETHAN MARKET"'::jsonb),
    ('support_email','"ethandigitalacademy@gmail.com"'::jsonb),('seller_payout_hold_days','7'::jsonb)
    ON CONFLICT(key) DO NOTHING`
];

async function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const db = getPool();
    // Normal production requests should not replay all DDL on every cold start.
    // Check the complete marketplace table set first; only bootstrap when needed.
    const requiredTables = [
      'market_users','market_sessions','market_categories','market_sellers',
      'market_products','market_product_variants','market_orders','market_order_items','market_payments',
      'market_payouts','market_disputes','market_wishlists','market_reviews','market_settings',
      'market_audit_logs','market_rate_limits','market_notifications','market_growth_profiles','market_growth_attributions','market_growth_campaigns','market_promo_codes','market_promo_redemptions','market_affiliate_conversions','market_growth_events','market_product_questions','market_conversations','market_messages','market_delivery_events'
    ];
    const countTables = async (executor) => {
      const result = await executor.query(
        "SELECT COUNT(*)::int AS count FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1::text[])",
        [requiredTables]
      );
      return Number(result.rows[0]?.count || 0);
    };
    const hasVariantColumns = async (executor) => {
      const result=await executor.query(`SELECT COUNT(*)::int AS count FROM information_schema.columns
        WHERE table_schema='public' AND table_name='market_order_items'
          AND column_name=ANY($1::text[])`,[['variant_id','variant_label','variant_sku']]);
      return Number(result.rows[0]?.count||0)===3;
    };
    const hasVariantIndexes = async (executor) => {
      const result=await executor.query(`SELECT COUNT(*)::int AS count FROM pg_indexes
        WHERE schemaname='public' AND indexname=ANY($1::text[])`,
        [['market_product_variants_seller_idx','market_order_items_variant_idx']]);
      return Number(result.rows[0]?.count||0)===2;
    };
    const hasCommunicationIndexes = async (executor) => {
      const result=await executor.query(`SELECT COUNT(*)::int AS count FROM pg_indexes
        WHERE schemaname='public' AND indexname=ANY($1::text[])`,
        [['market_product_questions_public_idx','market_conversations_product_uq','market_conversations_order_uq',
          'market_conversations_buyer_idx','market_conversations_seller_idx','market_messages_thread_idx',
          'market_messages_unread_idx','market_delivery_events_item_idx']]);
      return Number(result.rows[0]?.count||0)===8;
    };
    const hasPaymentColumns = async (executor) => {
      const result=await executor.query(`SELECT COUNT(*)::int AS count FROM information_schema.columns
        WHERE table_schema='public' AND table_name='market_orders'
          AND column_name=ANY($1::text[])`,[['payment_provider','payment_reference']]);
      return Number(result.rows[0]?.count||0)===2;
    };
    const hasPaymentIndex = async (executor) => {
      const result=await executor.query(`SELECT COUNT(*)::int AS count FROM pg_indexes
        WHERE schemaname='public' AND indexname='market_orders_payment_reference_uq'`);
      return Number(result.rows[0]?.count||0)===1;
    };
    if (await countTables(db) === requiredTables.length && await hasVariantColumns(db) &&
        await hasVariantIndexes(db) && await hasCommunicationIndexes(db) &&
        await hasPaymentColumns(db) && await hasPaymentIndex(db)) return;

    // Serialize only a genuine schema bootstrap. Re-check after obtaining the
    // lock in case another cold-start instance completed it while we waited.
    const client = await db.connect();
    const lockKey = 781204501;
    let locked = false;
    try {
      await client.query('SELECT pg_advisory_lock($1)', [lockKey]);
      locked = true;
      if (await countTables(client) !== requiredTables.length || !(await hasVariantColumns(client)) || !(await hasVariantIndexes(client)) || !(await hasCommunicationIndexes(client)) || !(await hasPaymentColumns(client)) || !(await hasPaymentIndex(client))) {
        for (const sql of schema) await client.query(sql);
      }
    } finally {
      if (locked) {
        try { await client.query('SELECT pg_advisory_unlock($1)', [lockKey]); } catch {}
      }
      client.release();
    }
  })().catch(err => { schemaPromise = null; throw err; });
  return schemaPromise;
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, maxAge) {
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

function safeOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) throw new HttpError(403, 'A same-origin browser request is required.');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  let parsed;
  try { parsed = new URL(origin); } catch { throw new HttpError(403, 'Request origin is not allowed.'); }
  if (parsed.host.toLowerCase() !== host || !['https:'].includes(parsed.protocol)) {
    throw new HttpError(403, 'Request origin is not allowed.');
  }
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY) { reject(new HttpError(413, 'Request is too large.')); req.destroy(); return; }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new HttpError(400, 'Request body must be valid JSON.')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.end(JSON.stringify(data));
}

function cleanEmail(v) { return String(v || '').trim().toLowerCase().slice(0, 254); }
function text(v, max = 5000) { return String(v ?? '').trim().slice(0, max); }
function money(v) { const n = Number(v); return Number.isSafeInteger(n) && n >= 0 ? n : 0; }
function slugify(v) { return text(v, 100).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || crypto.randomBytes(4).toString('hex'); }
function sha256(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}

function monnifyBaseUrl() {
  let value=String(process.env.MONNIFY_BASE_URL||'https://sandbox.monnify.com').trim();
  while(value.endsWith('/')) value=value.slice(0,-1);
  return value;
}
function monnifyConfigured() {
  return Boolean(process.env.MONNIFY_API_KEY && process.env.MONNIFY_SECRET_KEY &&
    process.env.MONNIFY_CONTRACT_CODE &&
    ['https://sandbox.monnify.com','https://api.monnify.com'].includes(monnifyBaseUrl()));
}

async function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const derived = await new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (e, key) => e ? reject(e) : resolve(key)));
  return `scrypt$131072$8$1$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function passwordVerify(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltHex, hashHex] = parts;
  if (!/^\d+$/.test(N) || !/^\d+$/.test(r) || !/^\d+$/.test(p) || !/^[a-f0-9]{32}$/i.test(saltHex) || !/^[a-f0-9]{128}$/i.test(hashHex)) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const got = await new Promise((resolve, reject) => crypto.scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024 }, (e, key) => e ? reject(e) : resolve(key)));
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

async function rateLimit(db, action, identity, max, minutes = 15) {
  const key = sha256(identity).slice(0, 48);
  const { rows } = await db.query(
    `INSERT INTO market_rate_limits(key,action,window_start,attempts) VALUES($1,$2,now(),1)
     ON CONFLICT(key,action) DO UPDATE SET
       attempts = CASE WHEN market_rate_limits.window_start < now() - ($3::text || ' minutes')::interval THEN 1 ELSE market_rate_limits.attempts + 1 END,
       window_start = CASE WHEN market_rate_limits.window_start < now() - ($3::text || ' minutes')::interval THEN now() ELSE market_rate_limits.window_start END
     RETURNING attempts`, [key, action, minutes]
  );
  if (Number(rows[0]?.attempts || 0) > max) throw new HttpError(429, 'Too many attempts. Please try again later.');
}

async function audit(db, userId, action, entityType = '', entityId = '', details = {}) {
  await db.query('INSERT INTO market_audit_logs(actor_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5)', [userId || null, action, entityType, String(entityId || ''), JSON.stringify(details)]);
}

async function currentUser(req, db, required = false) {
  const token = parseCookies(req)[COOKIE];
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
    if (required) throw new HttpError(401, 'Please sign in to continue.');
    return null;
  }
  const { rows } = await db.query(
    `SELECT u.id,u.full_name,u.email,u.phone,u.role,s.id AS session_id
     FROM market_sessions s JOIN market_users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.expires_at>now() AND u.is_active=true LIMIT 1`, [sha256(token)]
  );
  if (!rows.length) {
    if (required) throw new HttpError(401, 'Your session has ended. Please sign in again.');
    return null;
  }
  db.query('UPDATE market_sessions SET last_seen_at=now() WHERE id=$1', [rows[0].session_id]).catch(() => {});
  return rows[0];
}

async function requireRole(req, db, roles) {
  const user = await currentUser(req, db, true);
  if (!roles.includes(user.role)) throw new HttpError(403, 'You are not authorised to perform this action.');
  return user;
}

async function createSession(db, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = SESSION_DAYS * 24 * 60 * 60;
  await db.query('INSERT INTO market_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+($3::text||\' seconds\')::interval)', [userId, sha256(token), expires]);
  setCookie(res, COOKIE, token, expires);
}

function createGrowthCode() {
  return 'EM' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

async function ensureGrowthProfile(db,userId,campaign={}) {
  let result=await db.query('SELECT * FROM market_growth_profiles WHERE user_id=$1',[userId]);
  if(result.rows[0]) {
    const slug=text(campaign.campaign_slug,100),source=text(campaign.source,80),medium=text(campaign.medium,80);
    if(slug||source||medium) {
      result=await db.query(
        `UPDATE market_growth_profiles SET first_campaign_slug=CASE WHEN first_campaign_slug='' THEN $2 ELSE first_campaign_slug END,
         first_source=CASE WHEN first_source='' THEN $3 ELSE first_source END,
         first_medium=CASE WHEN first_medium='' THEN $4 ELSE first_medium END
         WHERE user_id=$1 RETURNING *`,[userId,slug,source,medium]
      );
    }
    return result.rows[0];
  }
  for(let attempt=0;attempt<4;attempt++) {
    try {
      result=await db.query(
        `INSERT INTO market_growth_profiles(user_id,referral_code,first_campaign_slug,first_source,first_medium)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO NOTHING RETURNING *`,
        [userId,createGrowthCode(),text(campaign.campaign_slug,100),text(campaign.source,80),text(campaign.medium,80)]
      );
      if(result.rows[0]) return result.rows[0];
      result=await db.query('SELECT * FROM market_growth_profiles WHERE user_id=$1',[userId]);
      if(result.rows[0]) return result.rows[0];
    } catch(error) { if(error.code!=='23505') throw error; }
  }
  throw new HttpError(503,'Could not create your marketplace referral code. Please try again.');
}

async function trackGrowthEvent(db,fields={}) {
  await db.query(
    `INSERT INTO market_growth_events(event_type,user_id,order_id,campaign_slug,source,medium,referral_code,path,metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [text(fields.event_type,60)||'market_event',fields.user_id||null,fields.order_id||null,
      text(fields.campaign_slug,100),text(fields.source,80),text(fields.medium,80),
      text(fields.referral_code,40).toUpperCase(),text(fields.path,180),
      JSON.stringify(fields.metadata&&typeof fields.metadata==='object'?fields.metadata:{})]
  );
}

async function resolvePromo(db,user,code,subtotal,marketplaceFee,lock=false) {
  if(!code) return null;
  const result=await db.query(
    `SELECT * FROM market_promo_codes WHERE code=$1 AND active=true
     AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>=now())
     ${lock?'FOR UPDATE':''}`,[code]
  );
  const promo=result.rows[0];
  if(!promo) throw new HttpError(400,'That promo code is invalid, expired or inactive.');
  if(subtotal<Number(promo.min_subtotal_kobo||0)) throw new HttpError(400,'Your basket does not meet the minimum spend for this promo code.');
  const usage=await db.query(
    `SELECT count(*)::int AS count FROM market_promo_redemptions
     WHERE promo_id=$1 AND status IN ('reserved','redeemed')
       AND (status='redeemed' OR created_at>=now()-interval '30 minutes')`,[promo.id]
  );
  if(promo.max_redemptions!==null && Number(usage.rows[0]?.count||0)>=Number(promo.max_redemptions))
    throw new HttpError(409,'This promo code has reached its redemption limit.');
  const personal=await db.query(
    `SELECT count(*)::int AS count FROM market_promo_redemptions
     WHERE promo_id=$1 AND user_id=$2 AND status IN ('reserved','redeemed')
       AND (status='redeemed' OR created_at>=now()-interval '30 minutes')`,[promo.id,user.id]
  );
  if(Number(personal.rows[0]?.count||0)>0) throw new HttpError(409,'This account has already used this promo code.');
  const requested=Math.round(subtotal*Number(promo.discount_bps)/10000);
  const capped=promo.max_discount_kobo>0?Math.min(requested,Number(promo.max_discount_kobo)):requested;
  const discount=Math.min(capped,marketplaceFee);
  if(discount<1) throw new HttpError(400,'This promo code cannot be applied to this basket.');
  return {id:promo.id,code:promo.code,discount_kobo:discount,discount_bps:Number(promo.discount_bps)};
}

async function growthDashboard(db,req) {
  const user=await requireRole(req,db,['buyer','seller','admin','super_admin']);
  const profile=await ensureGrowthProfile(db,user.id);
  const [referrals,conversions]=await Promise.all([
    db.query(
      `SELECT count(*)::int AS signups,count(*) FILTER(WHERE first_order_at IS NOT NULL)::int AS first_orders,
       count(*) FILTER(WHERE seller_approved_at IS NOT NULL)::int AS approved_sellers
       FROM market_growth_attributions WHERE referrer_user_id=$1`,[user.id]
    ),
    db.query(
      `SELECT count(*)::int AS orders,COALESCE(sum(sale_kobo),0)::bigint AS sales_kobo,
       COALESCE(sum(commission_kobo) FILTER(WHERE status IN ('pending','approved')),0)::bigint AS awaiting_kobo,
       COALESCE(sum(commission_kobo) FILTER(WHERE status='paid'),0)::bigint AS paid_kobo
       FROM market_affiliate_conversions WHERE affiliate_user_id=$1`,[user.id]
    )
  ]);
  const recent=await db.query(
    `SELECT a.status,a.created_at,u.full_name FROM market_growth_attributions a
     JOIN market_users u ON u.id=a.referred_user_id WHERE a.referrer_user_id=$1
     ORDER BY a.created_at DESC LIMIT 20`,[user.id]
  );
  let store=null, products=[];
  if(user.role==='seller') {
    const sellerResult=await db.query(
      'SELECT id,store_name,slug,seller_status FROM market_sellers WHERE user_id=$1 LIMIT 1',
      [user.id]
    );
    if(sellerResult.rows[0]) {
      const seller=sellerResult.rows[0];
      store={
        store_name:seller.store_name,slug:seller.slug,seller_status:seller.seller_status,
        url:seller.seller_status==='approved'?'https://market.ethandigitalacademy.org/store/'+encodeURIComponent(seller.slug):''
      };
      if(seller.seller_status==='approved') {
        const productResult=await db.query(
          `SELECT id,name,slug,price_kobo FROM market_products
           WHERE seller_id=$1 AND status='active'
           ORDER BY featured DESC,created_at DESC LIMIT 12`,
          [seller.id]
        );
        products=productResult.rows.map(p=>({
          ...p,
          url:'https://market.ethandigitalacademy.org/product/'+encodeURIComponent(p.slug||p.id)+'/'+encodeURIComponent(p.id)
        }));
      }
    }
  }
  return {
    referral_code:profile.referral_code,
    referral_url:'https://market.ethandigitalacademy.org/?ref='+encodeURIComponent(profile.referral_code),
    affiliate_status:profile.affiliate_status,
    affiliate_commission_bps:Number(profile.affiliate_commission_bps||0),
    referrals:referrals.rows[0],conversions:conversions.rows[0],recent:recent.rows,
    store,products
  };
}

async function applyAffiliate(db,req) {
  const user=await requireRole(req,db,['buyer','seller']);
  const profile=await ensureGrowthProfile(db,user.id);
  if(profile.affiliate_status==='approved') return {status:'approved'};
  if(profile.affiliate_status==='pending') return {status:'pending'};
  await db.query("UPDATE market_growth_profiles SET affiliate_status='pending' WHERE user_id=$1",[user.id]);
  const admins=await db.query("SELECT id FROM market_users WHERE role IN ('admin','super_admin') AND is_active=true");
  for(const admin of admins.rows) await createNotification(db,admin.id,{
    type:'affiliate_application',title:'New affiliate application',
    message:`${user.full_name} has applied to join the ETHAN MARKET affiliate programme.`,
    target_tab:'growth',dedupe_key:`affiliate-application:${user.id}`,metadata:{affiliate_user_id:user.id}
  });
  await audit(db,user.id,'AFFILIATE_APPLICATION_SUBMITTED','affiliate',user.id);
  return {status:'pending'};
}

async function growthTrack(db,req,body) {
  const ip=String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim();
  await rateLimit(db,'growth-track',ip,90,5);
  const allowed=['page_view','product_view','store_view','signup_view','checkout_started'];
  const event=text(body.event_type,60);
  if(!allowed.includes(event)) throw new HttpError(400,'Unsupported growth tracking event.');
  const user=await currentUser(req,db,false);
  await trackGrowthEvent(db,{
    event_type:event,user_id:user?.id||null,campaign_slug:text(body.campaign_slug,100),
    source:text(body.source,80),medium:text(body.medium,80),
    referral_code:text(body.referral_code,40).toUpperCase(),path:text(body.path,180)
  });
  return {ok:true};
}

async function growthPromoPreview(db,req,body) {
  const user=await requireRole(req,db,['buyer','seller','admin','super_admin']);
  await rateLimit(db,'promo-preview',user.id,20,15);
  const items=Array.isArray(body.items)?body.items:[];
  if(!items.length||items.length>30) throw new HttpError(400,'Add products to your basket before applying a code.');
  const ids=[...new Set(items.map(x=>text(x.product_id,80)).filter(x=>/^[0-9a-f-]{36}$/i.test(x)))];
  if(!ids.length) throw new HttpError(400,'Your basket is not valid.');
  const {rows}=await db.query(
    `SELECT p.id,p.price_kobo,p.product_type,s.commission_bps FROM market_products p
     JOIN market_sellers s ON s.id=p.seller_id WHERE p.id=ANY($1::uuid[]) AND p.status='active' AND s.seller_status='approved'`,[ids]
  );
  if(rows.length!==ids.length) throw new HttpError(409,'One or more products are no longer available.');
  const productMap=new Map(rows.map(product=>[product.id,product]));
  const {rows:variants}=await db.query(`SELECT id,product_id,label,price_kobo FROM market_product_variants WHERE product_id=ANY($1::uuid[]) AND is_active=true`,[ids]);
  const variantMap=new Map(variants.map(variant=>[variant.id,variant]));
  const optionCounts=new Map();
  for(const variant of variants) optionCounts.set(variant.product_id,(optionCounts.get(variant.product_id)||0)+1);
  let subtotal=0,fee=0,physical=false;
  for(const item of items) {
    const product=productMap.get(text(item.product_id,80));
    if(!product) throw new HttpError(400,'A product in your basket is invalid or no longer available.');
    const quantity=Math.min(20,Math.max(1,parseInt(item.quantity,10)||1));
    const variantId=text(item.variant_id,80),variant=variantId?variantMap.get(variantId):null;
    if(variantId&&(!variant||variant.product_id!==product.id)) throw new HttpError(409,'A selected product option is no longer available.');
    if(!variantId&&optionCounts.get(product.id)) throw new HttpError(400,'Choose an option for '+product.id+' before applying a promo code.');
    const price=Number(variant?.price_kobo||product.price_kobo);
    subtotal+=price*quantity;
    fee+=Math.round(price*quantity*Number(product.commission_bps)/10000);
    if(product.product_type==='physical') physical=true;
  }
  const promo=await resolvePromo(db,user,text(body.code,40).toUpperCase(),subtotal,fee,false);
  const settings=await getSettings(db);
  return {code:promo.code,discount_kobo:promo.discount_kobo,subtotal_kobo:subtotal,estimated_total_kobo:Math.max(0,subtotal+(physical?Number(settings.physical_shipping_kobo??200000):0)-promo.discount_kobo)};
}

async function adminGrowthOverview(db,req) {
  await requireRole(req,db,['admin','super_admin']);
  const [summary,campaigns,promos,affiliates,conversions,referrals]=await Promise.all([
    db.query(`SELECT
      (SELECT count(*) FROM market_users WHERE created_at>=now()-interval '30 days')::int AS signups_30d,
      (SELECT count(*) FROM market_growth_attributions WHERE created_at>=now()-interval '30 days')::int AS referred_signups_30d,
      (SELECT count(*) FROM market_growth_attributions WHERE first_order_at>=now()-interval '30 days')::int AS referred_buyers_30d,
      (SELECT count(*) FROM market_growth_attributions WHERE seller_approved_at>=now()-interval '30 days')::int AS referred_sellers_30d,
      (SELECT count(*) FROM market_sellers WHERE seller_status='approved' AND updated_at>=now()-interval '30 days')::int AS approved_sellers_30d,
      (SELECT count(*) FROM market_orders WHERE payment_status='paid' AND created_at>=now()-interval '30 days')::int AS paid_orders_30d,
      (SELECT COALESCE(sum(total_kobo),0) FROM market_orders WHERE payment_status='paid' AND created_at>=now()-interval '30 days')::bigint AS gmv_30d,
      (SELECT count(*) FROM market_promo_redemptions WHERE status='redeemed' AND redeemed_at>=now()-interval '30 days')::int AS promo_redemptions_30d,
      (SELECT count(*) FROM market_affiliate_conversions WHERE status='pending')::int AS affiliate_pending`),
    db.query(`SELECT c.*,
      (SELECT count(*) FROM market_growth_events e WHERE e.campaign_slug=c.slug AND e.event_type='page_view')::int AS visits,
      (SELECT count(*) FROM market_growth_events e WHERE e.campaign_slug=c.slug AND e.event_type='signup_view')::int AS signup_views,
      (SELECT count(*) FROM market_growth_events e WHERE e.campaign_slug=c.slug AND e.event_type='signup')::int AS signups,
      (SELECT count(*) FROM market_orders o WHERE o.campaign_slug=c.slug AND o.payment_status='paid')::int AS orders,
      (SELECT COALESCE(sum(o.total_kobo),0) FROM market_orders o WHERE o.campaign_slug=c.slug AND o.payment_status='paid')::bigint AS gmv_kobo
      FROM market_growth_campaigns c ORDER BY c.created_at DESC LIMIT 100`),
    db.query(`SELECT p.*,(SELECT count(*) FROM market_promo_redemptions r WHERE r.promo_id=p.id AND r.status='redeemed')::int AS redemptions,
      (SELECT COALESCE(sum(r.discount_kobo),0) FROM market_promo_redemptions r WHERE r.promo_id=p.id AND r.status='redeemed')::bigint AS discount_spend
      FROM market_promo_codes p ORDER BY p.created_at DESC LIMIT 100`),
    db.query(`SELECT g.user_id,g.referral_code,g.affiliate_status,g.affiliate_commission_bps,u.full_name,u.email,
      (SELECT count(*) FROM market_affiliate_conversions x WHERE x.affiliate_user_id=g.user_id)::int AS conversions,
      (SELECT COALESCE(sum(commission_kobo),0) FROM market_affiliate_conversions x WHERE x.affiliate_user_id=g.user_id AND x.status IN ('pending','approved'))::bigint AS awaiting_kobo
      FROM market_growth_profiles g JOIN market_users u ON u.id=g.user_id
      WHERE g.affiliate_status<>'none' ORDER BY g.created_at DESC LIMIT 100`),
    db.query(`SELECT x.*,u.full_name AS affiliate_name,o.order_number FROM market_affiliate_conversions x
      JOIN market_users u ON u.id=x.affiliate_user_id JOIN market_orders o ON o.id=x.order_id
      ORDER BY x.created_at DESC LIMIT 100`),
    db.query(`SELECT a.*,r.full_name AS referrer_name,u.full_name AS referred_name,u.email AS referred_email
      FROM market_growth_attributions a JOIN market_users r ON r.id=a.referrer_user_id
      JOIN market_users u ON u.id=a.referred_user_id ORDER BY a.created_at DESC LIMIT 100`)
  ]);
  return {summary:summary.rows[0],campaigns:campaigns.rows,promos:promos.rows,affiliates:affiliates.rows,conversions:conversions.rows,referrals:referrals.rows};
}

async function authRegister(db, req, res, body) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  await rateLimit(db, 'register', ip, 8, 60);
  const fullName = text(body.full_name, 120);
  const email = cleanEmail(body.email);
  const phone = text(body.phone, 40);
  const password = String(body.password || '');
  const ownerToken = String(body.owner_token || '');
  const referralCode=text(body.referral_code,40).toUpperCase();
  const campaign={campaign_slug:text(body.campaign_slug,100),source:text(body.utm_source,80),medium:text(body.utm_medium,80)};
  if (fullName.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter your full name and a valid email address.');
  if (password.length < 10 || Buffer.byteLength(password, 'utf8') > 128) throw new HttpError(400, 'Use a password of at least 10 characters.');
  let role = 'buyer';
  const configuredOwner = cleanEmail(process.env.MARKET_SUPER_ADMIN_EMAIL);
  if (email === configuredOwner) {
    const setting = await db.query("SELECT value FROM market_settings WHERE key='owner_bootstrap_used'");
    const used = setting.rows[0]?.value === true;
    const codeMatches = safeEqual(sha256(ownerToken), OWNER_SETUP_HASH);
    if (used || !codeMatches) {
      throw new HttpError(403, 'The owner setup code is invalid or has already been used. Request a fresh owner activation code.');
    }
    role = 'super_admin';
  }
  const hash = await passwordHash(password);
  const client = await db.connect();
  let user;
  try {
    await client.query('BEGIN');
    const created = await client.query(
      'INSERT INTO market_users(full_name,email,phone,password_hash,role) VALUES($1,$2,$3,$4,$5) RETURNING id,full_name,email,phone,role',
      [fullName,email,phone,hash,role]
    );
    user = created.rows[0];
    if (role === 'super_admin') {
      await client.query("INSERT INTO market_settings(key,value) VALUES('owner_bootstrap_used','true'::jsonb) ON CONFLICT(key) DO UPDATE SET value='true'::jsonb,updated_at=now()");
      await client.query("DELETE FROM market_settings WHERE key='owner_bootstrap_token_hash'");
    }
    await ensureGrowthProfile(client,user.id,campaign);
    if(referralCode) {
      const referrer=await client.query('SELECT user_id FROM market_growth_profiles WHERE upper(referral_code)=$1 LIMIT 1',[referralCode]);
      if(referrer.rows[0] && referrer.rows[0].user_id!==user.id) {
        await client.query(
          `INSERT INTO market_growth_attributions(referrer_user_id,referred_user_id,referral_code)
           VALUES($1,$2,$3) ON CONFLICT(referred_user_id) DO NOTHING`,
          [referrer.rows[0].user_id,user.id,referralCode]
        );
      }
    }
    await trackGrowthEvent(client,{event_type:'signup',user_id:user.id,campaign_slug:campaign.campaign_slug,source:campaign.source,medium:campaign.medium,referral_code:referralCode});
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); if (e.code === '23505') throw new HttpError(409, 'An account with this email already exists.'); throw e; }
  finally { client.release(); }
  await createSession(db, res, user.id);
  await audit(db, user.id, 'ACCOUNT_REGISTERED', 'user', user.id, { role });
  return { user: publicUser(user) };
}

async function authLogin(db, req, res, body) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const email = cleanEmail(body.email);
  await rateLimit(db, 'login', ip + '|' + email, 8, 15);
  const { rows } = await db.query('SELECT id,full_name,email,phone,password_hash,role,is_active FROM market_users WHERE lower(email)=$1 LIMIT 1', [email]);
  const user = rows[0];
  if (!user || !user.is_active || !(await passwordVerify(String(body.password || ''), user.password_hash))) throw new HttpError(401, 'Email or password is incorrect.');
  await createSession(db, res, user.id);
  await audit(db, user.id, 'ACCOUNT_LOGIN', 'user', user.id);
  return { user: publicUser(user) };
}

function publicUser(user) {
  return { id: user.id, full_name: user.full_name, email: user.email, phone: user.phone || '', role: user.role };
}

async function authMe(db, req) {
  const user = await currentUser(req, db, false);
  if (!user) return { user: null };
  const { rows } = await db.query('SELECT id,store_name,slug,description,seller_status,commission_bps,city,state FROM market_sellers WHERE user_id=$1', [user.id]);
  await ensureGrowthProfile(db,user.id);
  return { user: publicUser(user), seller: rows[0] || null };
}

async function signOut(db, req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) await db.query('DELETE FROM market_sessions WHERE token_hash=$1', [sha256(token)]);
  clearCookie(res);
  return { ok: true };
}

async function getSettings(db) {
  const { rows } = await db.query('SELECT key,value FROM market_settings');
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

async function publicCategories(db) {
  const { rows } = await db.query('SELECT id,name,slug,icon FROM market_categories WHERE is_active=true ORDER BY sort_order,name');
  return rows;
}

async function listProducts(db, params = {}) {
  const values = [];
  const where = [`p.status='active'`, `s.seller_status='approved'`];
  if (params.category) { values.push(text(params.category,80)); where.push(`c.slug=$${values.length}`); }
  if (params.type && ['physical','digital'].includes(params.type)) { values.push(params.type); where.push(`p.product_type=$${values.length}`); }
  if (params.q) { values.push('%' + text(params.q,100).replace(/[%_]/g,'\\$&') + '%'); where.push(`(p.name ILIKE $${values.length} OR p.description ILIKE $${values.length} OR s.store_name ILIKE $${values.length})`); }
  if (params.featured === 'true') where.push('p.featured=true');
  let order = 'p.featured DESC,p.created_at DESC';
  if (params.sort === 'price-asc') order = 'COALESCE(v.from_price_kobo,p.price_kobo) ASC,p.created_at DESC';
  if (params.sort === 'price-desc') order = 'COALESCE(v.from_price_kobo,p.price_kobo) DESC,p.created_at DESC';
  if (params.sort === 'popular') order = 'p.views DESC,p.created_at DESC';
  const limit = Math.min(Math.max(Number(params.limit) || 24, 1), 60);
  values.push(limit);
  const { rows } = await db.query(
    `SELECT p.id,p.name,p.slug,p.description,p.product_type,p.price_kobo,p.compare_at_kobo,p.image_url,p.stock_qty,p.featured,p.created_at,
       c.name AS category_name,c.slug AS category_slug,s.id AS seller_id,s.store_name,s.slug AS store_slug,s.city,s.state,
       COALESCE(v.variant_count,0)::int AS variant_count,v.from_price_kobo,
       COALESCE(rv.avg_rating,0) AS rating,COALESCE(rv.review_count,0) AS review_count
     FROM market_products p JOIN market_sellers s ON s.id=p.seller_id LEFT JOIN market_categories c ON c.id=p.category_id
     LEFT JOIN (SELECT option.product_id,count(*) AS variant_count,
       min(COALESCE(option.price_kobo,base.price_kobo)) AS from_price_kobo
       FROM market_product_variants option JOIN market_products base ON base.id=option.product_id
       WHERE option.is_active=true GROUP BY option.product_id) v ON v.product_id=p.id
     LEFT JOIN (SELECT product_id,round(avg(rating)::numeric,1) AS avg_rating,count(*) AS review_count FROM market_reviews GROUP BY product_id) rv ON rv.product_id=p.id
     WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${values.length}`,
    values
  );
  return rows;
}

async function askProductQuestion(db,req,body) {
  const user=await requireRole(req,db,['buyer','seller']);
  const productId=text(body.product_id,80),question=text(body.question,1000);
  if(question.length<10) throw new HttpError(400,'Write a question of at least 10 characters.');
  await rateLimit(db,'product-question',user.id,6,60);
  const product=await db.query(`SELECT p.id,p.name,s.user_id AS seller_user_id FROM market_products p
    JOIN market_sellers s ON s.id=p.seller_id WHERE p.id=$1 AND p.status='active' AND s.seller_status='approved'`,[productId]);
  if(!product.rows.length) throw new HttpError(404,'This product is no longer available.');
  if(product.rows[0].seller_user_id===user.id) throw new HttpError(400,'You cannot ask a question on your own product.');
  const result=await db.query(`INSERT INTO market_product_questions(product_id,asker_id,question)
    VALUES($1,$2,$3) RETURNING id,created_at`,[productId,user.id,question]);
  await createNotification(db,product.rows[0].seller_user_id,{type:'product_question',title:'New product question',
    message:user.full_name+' asked about '+product.rows[0].name+': '+question.slice(0,220),
    target_tab:'questions',metadata:{question_id:result.rows[0].id,product_id:productId}});
  await audit(db,user.id,'PRODUCT_QUESTION_SUBMITTED','product_question',result.rows[0].id,{product_id:productId});
  return {question:result.rows[0]};
}

async function answerProductQuestion(db,req,body) {
  const user=await requireRole(req,db,['seller']);
  const seller=await getSellerByUser(db,user.id,true);
  const id=text(body.question_id,80),answer=text(body.answer,1000);
  if(answer.length<2) throw new HttpError(400,'Write an answer before submitting.');
  const result=await db.query(`UPDATE market_product_questions q SET answer=$3,status='answered',answered_by=$4,answered_at=now()
    FROM market_products p WHERE q.id=$1 AND p.id=q.product_id AND p.seller_id=$2 AND q.status='open'
    RETURNING q.id,q.asker_id,q.product_id,p.name`,[id,seller.id,answer,user.id]);
  if(!result.rows.length) throw new HttpError(404,'This open question was not found in your store.');
  const row=result.rows[0];
  await createNotification(db,row.asker_id,{type:'product_question_answered',title:'The seller answered your question',
    message:'The seller of '+row.name+' replied to your product question.',target_tab:'orders',
    metadata:{question_id:id,product_id:row.product_id}});
  await audit(db,user.id,'PRODUCT_QUESTION_ANSWERED','product_question',id);
  return {ok:true};
}

async function openMessageConversation(db,req,body) {
  const user=await requireRole(req,db,['buyer','seller']);
  const productId=text(body.product_id,80),itemId=text(body.order_item_id,80);
  if(Boolean(productId)===Boolean(itemId)) throw new HttpError(400,'Choose a product enquiry or a specific order item.');
  let buyerId,sellerUserId,contextType,contextId;
  if(productId) {
    const product=await db.query(`SELECT p.id,s.user_id AS seller_user_id FROM market_products p JOIN market_sellers s ON s.id=p.seller_id
      WHERE p.id=$1 AND p.status='active' AND s.seller_status='approved'`,[productId]);
    if(!product.rows.length) throw new HttpError(404,'This product is no longer available.');
    sellerUserId=product.rows[0].seller_user_id;buyerId=user.id;contextType='product';contextId=productId;
    if(sellerUserId===user.id) throw new HttpError(400,'You cannot message yourself about your own product.');
  } else {
    const item=await db.query(`SELECT oi.id,o.buyer_id,s.user_id AS seller_user_id,o.payment_status FROM market_order_items oi
      JOIN market_orders o ON o.id=oi.order_id JOIN market_sellers s ON s.id=oi.seller_id WHERE oi.id=$1`,[itemId]);
    if(!item.rows.length) throw new HttpError(404,'Order item not found.');
    const row=item.rows[0];
    if(row.payment_status!=='paid') throw new HttpError(409,'Order conversations open after payment is confirmed.');
    if(user.id!==row.buyer_id && user.id!==row.seller_user_id) throw new HttpError(403,'You are not a participant in this order.');
    buyerId=row.buyer_id;sellerUserId=row.seller_user_id;contextType='order';contextId=itemId;
  }
  const result=contextType==='product'
    ? await db.query(`INSERT INTO market_conversations(buyer_id,seller_user_id,context_type,product_id)
        VALUES($1,$2,'product',$3) ON CONFLICT (buyer_id,seller_user_id,product_id) WHERE context_type='product'
        DO UPDATE SET updated_at=now() RETURNING id`,[buyerId,sellerUserId,contextId])
    : await db.query(`INSERT INTO market_conversations(buyer_id,seller_user_id,context_type,order_item_id)
        VALUES($1,$2,'order',$3) ON CONFLICT (order_item_id) WHERE context_type='order'
        DO UPDATE SET updated_at=now() RETURNING id`,[buyerId,sellerUserId,contextId]);
  return {conversation_id:result.rows[0].id};
}

async function messageThreads(db,req) {
  const user=await requireRole(req,db,['buyer','seller']);
  const result=await db.query(`SELECT c.id,c.context_type,c.updated_at,
      CASE WHEN c.buyer_id=$1 THEN su.full_name ELSE bu.full_name END AS other_name,
      COALESCE(p.name,oi.product_name,'ETHAN MARKET conversation') AS context_title,
      o.order_number,latest.body AS last_message,latest.created_at AS last_message_at,
      (SELECT count(*)::int FROM market_messages unread WHERE unread.conversation_id=c.id
        AND unread.sender_id<>$1 AND unread.read_at IS NULL) AS unread_count
    FROM market_conversations c JOIN market_users bu ON bu.id=c.buyer_id JOIN market_users su ON su.id=c.seller_user_id
    LEFT JOIN market_products p ON p.id=c.product_id LEFT JOIN market_order_items oi ON oi.id=c.order_item_id
    LEFT JOIN market_orders o ON o.id=oi.order_id
    LEFT JOIN LATERAL (SELECT m.body,m.created_at FROM market_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) latest ON true
    WHERE c.buyer_id=$1 OR c.seller_user_id=$1
    ORDER BY COALESCE(latest.created_at,c.updated_at) DESC LIMIT 60`,[user.id]);
  return {threads:result.rows};
}

async function messageThread(db,req,body) {
  const user=await requireRole(req,db,['buyer','seller']),id=text(body.conversation_id,80);
  const conversation=await db.query(`SELECT c.id,c.context_type,c.buyer_id,c.seller_user_id,
      CASE WHEN c.buyer_id=$2 THEN su.full_name ELSE bu.full_name END AS other_name,
      COALESCE(p.name,oi.product_name,'ETHAN MARKET conversation') AS context_title,o.order_number
    FROM market_conversations c JOIN market_users bu ON bu.id=c.buyer_id JOIN market_users su ON su.id=c.seller_user_id
    LEFT JOIN market_products p ON p.id=c.product_id LEFT JOIN market_order_items oi ON oi.id=c.order_item_id
    LEFT JOIN market_orders o ON o.id=oi.order_id
    WHERE c.id=$1 AND (c.buyer_id=$2 OR c.seller_user_id=$2) LIMIT 1`,[id,user.id]);
  if(!conversation.rows.length) throw new HttpError(404,'Conversation not found.');
  await db.query('UPDATE market_messages SET read_at=now() WHERE conversation_id=$1 AND sender_id<>$2 AND read_at IS NULL',[id,user.id]);
  const messages=await db.query('SELECT id,sender_id,body,created_at,read_at FROM market_messages WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 100',[id]);
  return {conversation:conversation.rows[0],messages:messages.rows.reverse()};
}

async function sendMessage(db,req,body) {
  const user=await requireRole(req,db,['buyer','seller']),id=text(body.conversation_id,80),message=text(body.message,2000);
  if(!message) throw new HttpError(400,'Write a message before sending.');
  await rateLimit(db,'market-message',user.id,50,15);
  const result=await db.query('SELECT id,buyer_id,seller_user_id FROM market_conversations WHERE id=$1 AND (buyer_id=$2 OR seller_user_id=$2) LIMIT 1',[id,user.id]);
  if(!result.rows.length) throw new HttpError(404,'Conversation not found.');
  const conversation=result.rows[0],recipient=conversation.buyer_id===user.id?conversation.seller_user_id:conversation.buyer_id;
  const inserted=await db.query(`INSERT INTO market_messages(conversation_id,sender_id,body) VALUES($1,$2,$3)
    RETURNING id,sender_id,body,created_at,read_at`,[id,user.id,message]);
  await db.query('UPDATE market_conversations SET updated_at=now() WHERE id=$1',[id]);
  await createNotification(db,recipient,{type:'market_message',title:'New ETHAN MARKET message',
    message:user.full_name+' sent you a message: '+message.slice(0,180),target_tab:'messages',
    metadata:{conversation_id:id,message_id:inserted.rows[0].id}});
  return {message:inserted.rows[0]};
}

async function productDetail(db, idOrSlug) {
  const { rows } = await db.query(
    `SELECT p.id,p.name,p.slug,p.description,p.product_type,p.price_kobo,p.compare_at_kobo,p.image_url,p.stock_qty,p.featured,p.created_at,
      c.name AS category_name,c.slug AS category_slug,s.id AS seller_id,s.store_name,s.slug AS store_slug,s.description AS store_description,s.city,s.state,
      COALESCE(rv.avg_rating,0) AS rating,COALESCE(rv.review_count,0) AS review_count
     FROM market_products p JOIN market_sellers s ON s.id=p.seller_id LEFT JOIN market_categories c ON c.id=p.category_id
     LEFT JOIN (SELECT product_id,round(avg(rating)::numeric,1) AS avg_rating,count(*) AS review_count FROM market_reviews GROUP BY product_id) rv ON rv.product_id=p.id
     WHERE p.status='active' AND s.seller_status='approved' AND (p.id::text=$1 OR p.slug=$1) LIMIT 1`, [text(idOrSlug,120)]
  );
  if (!rows.length) throw new HttpError(404, 'Product not found.');
  await db.query('UPDATE market_products SET views=views+1 WHERE id=$1', [rows[0].id]);
  const variants=await db.query(`SELECT id,label,sku,price_kobo,stock_qty
    FROM market_product_variants WHERE product_id=$1 AND is_active=true ORDER BY label`,[rows[0].id]);
  const questions=await db.query(`SELECT q.id,q.question,q.answer,q.status,q.created_at,q.answered_at,
      split_part(au.full_name,' ',1) AS asker_name
    FROM market_product_questions q JOIN market_users au ON au.id=q.asker_id
    WHERE q.product_id=$1 AND q.status IN ('open','answered') ORDER BY q.created_at DESC LIMIT 20`,[rows[0].id]);
  return {...rows[0],variants:variants.rows,questions:questions.rows};
}

async function getSellerByUser(db, userId, mustApproved = true) {
  const { rows } = await db.query('SELECT * FROM market_sellers WHERE user_id=$1 LIMIT 1', [userId]);
  if (!rows.length) throw new HttpError(403, 'Apply to become a seller before using the seller dashboard.');
  if (mustApproved && rows[0].seller_status !== 'approved') throw new HttpError(403, 'Your seller account is awaiting marketplace approval.');
  return rows[0];
}

async function applySeller(db, req, body) {
  const user = await requireRole(req, db, ['buyer','seller','admin','super_admin']);
  const storeName = text(body.store_name,120);
  const slug = slugify(body.slug || storeName);
  if (storeName.length < 2) throw new HttpError(400, 'Enter a store name.');
  const existing = await db.query('SELECT id FROM market_sellers WHERE user_id=$1', [user.id]);
  if (existing.rows.length) throw new HttpError(409, 'A seller application already exists for this account.');
  try {
    const settings = await getSettings(db);
    const defaultCommission = Math.min(Math.max(Number(settings.commission_bps ?? 1000), 0), 5000);
    const { rows } = await db.query(
      `INSERT INTO market_sellers(user_id,store_name,slug,description,phone,whatsapp,business_type,city,state,bank_name,bank_code,account_number,account_name,commission_bps)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id,store_name,slug,seller_status`,
      [user.id,storeName,slug,text(body.description,1500),text(body.phone,40),text(body.whatsapp,40),['individual','registered_business'].includes(body.business_type)?body.business_type:'individual',text(body.city,80),text(body.state,80),text(body.bank_name,120),encryptField(body.bank_code),encryptField(body.account_number),text(body.account_name,120),defaultCommission]
    );
    const referredBy=await db.query('SELECT referral_code FROM market_growth_attributions WHERE referred_user_id=$1',[user.id]);
    await trackGrowthEvent(db,{event_type:'seller_application',user_id:user.id,referral_code:referredBy.rows[0]?.referral_code||''});
    await audit(db,user.id,'SELLER_APPLICATION_SUBMITTED','seller',rows[0].id);
    // Notify every active marketplace administrator so new applications enter
    // the owner review queue immediately, without relying on manual refreshes.
    try {
      const admins=await db.query("SELECT id FROM market_users WHERE role IN ('admin','super_admin') AND is_active=true");
      await Promise.all(admins.rows.map(admin=>createNotification(db,admin.id,{
        type:'seller_application_submitted',
        title:'New seller application awaiting review',
        message:`${user.full_name} submitted an application for ${rows[0].store_name}. Review the application in your seller queue.`,
        target_tab:'sellers',
        dedupe_key:`seller-application:${rows[0].id}`,
        metadata:{seller_id:rows[0].id,store_name:rows[0].store_name}
      }).catch(()=>{})));
    } catch(error) { console.error('Could not notify marketplace administrators of seller application:',error.message); }
    return { seller: rows[0] };
  } catch(e) { if(e.code==='23505') throw new HttpError(409,'That store address is already in use.'); throw e; }
}

async function createNotification(db, userId, fields = {}) {
  if (!userId) return;
  const type=text(fields.type,60)||'market_update';
  const title=text(fields.title,140)||'ETHAN MARKET update';
  const message=text(fields.message,500);
  const targetTab=['orders','products','disputes','payouts','overview','growth','sellers','messages','questions'].includes(fields.target_tab)?fields.target_tab:'orders';
  const dedupeKey=text(fields.dedupe_key,180);
  const metadata=fields.metadata&&typeof fields.metadata==='object'?fields.metadata:{};
  await db.query(
    `INSERT INTO market_notifications(user_id,type,title,message,target_tab,dedupe_key,metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (user_id,dedupe_key) WHERE dedupe_key <> '' DO NOTHING`,
    [userId,type,title,message,targetTab,dedupeKey,JSON.stringify(metadata)]
  );
}

async function notificationsList(db, req) {
  const user=await requireRole(req,db,['buyer','seller','admin','super_admin']);
  const [items,unread]=await Promise.all([
    db.query(`SELECT id,type,title,message,target_tab,metadata,read_at,created_at
      FROM market_notifications WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50`,[user.id]),
    db.query('SELECT count(*)::int AS count FROM market_notifications WHERE user_id=$1 AND read_at IS NULL',[user.id])
  ]);
  return {notifications:items.rows,unread_count:Number(unread.rows[0]?.count||0)};
}

async function notificationsMarkRead(db, req, body) {
  const user=await requireRole(req,db,['buyer','seller','admin','super_admin']);
  if(body.all===true) {
    const result=await db.query('UPDATE market_notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL',[user.id]);
    return {ok:true,updated:result.rowCount||0};
  }
  const id=text(body.id,80);
  if(!id) throw new HttpError(400,'Choose a notification to mark as read.');
  const result=await db.query('UPDATE market_notifications SET read_at=now() WHERE id=$1 AND user_id=$2 AND read_at IS NULL',[id,user.id]);
  return {ok:true,updated:result.rowCount||0};
}

async function sellerDashboard(db, req) {
  const user = await requireRole(req, db, ['seller','admin','super_admin']);
  const seller = await getSellerByUser(db,user.id,true);
  const [products, orders, payouts, disputes, salesSummary, salesTrend, topProducts, totalViews] = await Promise.all([
    db.query(`SELECT p.id,p.name,p.price_kobo,p.compare_at_kobo,p.stock_qty,p.status,p.product_type,p.created_at,p.description,p.image_url,p.sku,p.digital_delivery_url,p.views,c.name AS category_name,c.id AS category_id FROM market_products p LEFT JOIN market_categories c ON c.id=p.category_id WHERE p.seller_id=$1 ORDER BY p.created_at DESC LIMIT 100`,[seller.id]),
    db.query(`SELECT oi.id,oi.product_name,oi.variant_label,oi.variant_sku,oi.quantity,oi.unit_price_kobo,oi.fulfillment_status,oi.tracking_number,oi.tracking_carrier,o.order_number,o.status,o.payment_status,o.created_at,o.recipient_name,o.phone,o.shipping_address,oi.buyer_confirmed_at
      FROM market_order_items oi JOIN market_orders o ON o.id=oi.order_id WHERE oi.seller_id=$1 AND o.payment_status='paid' ORDER BY o.created_at DESC LIMIT 100`,[seller.id]),
    db.query('SELECT id,gross_kobo,commission_kobo,net_kobo,status,payout_reference,eligible_at,hold_reason,created_at,paid_at FROM market_payouts WHERE seller_id=$1 ORDER BY created_at DESC LIMIT 100',[seller.id]),
    db.query(`SELECT d.*,o.order_number,oi.product_name,u.full_name AS buyer_name FROM market_disputes d
      JOIN market_orders o ON o.id=d.order_id JOIN market_order_items oi ON oi.id=d.order_item_id
      JOIN market_users u ON u.id=d.buyer_id WHERE d.seller_id=$1 ORDER BY d.opened_at DESC LIMIT 100`,[seller.id]),
    db.query(`SELECT COALESCE(SUM(oi.unit_price_kobo*oi.quantity),0)::text AS gross_revenue_kobo,
      COUNT(DISTINCT oi.order_id)::int AS paid_orders,COALESCE(SUM(oi.quantity),0)::int AS units_sold
      FROM market_order_items oi JOIN market_orders o ON o.id=oi.order_id
      WHERE oi.seller_id=$1 AND o.payment_status='paid' AND o.created_at>=now()-interval '30 days'`,[seller.id]),
    db.query(`WITH sales AS (
        SELECT o.created_at::date AS sale_day,oi.order_id,
          SUM(oi.unit_price_kobo*oi.quantity)::bigint AS revenue_kobo
        FROM market_order_items oi JOIN market_orders o ON o.id=oi.order_id
        WHERE oi.seller_id=$1 AND o.payment_status='paid'
          AND o.created_at>=current_date-interval '13 days'
        GROUP BY o.created_at::date,oi.order_id
      )
      SELECT to_char(days.day,'YYYY-MM-DD') AS day,
        COALESCE(SUM(sales.revenue_kobo),0)::text AS revenue_kobo,
        COUNT(sales.order_id)::int AS orders
      FROM generate_series(current_date-interval '13 days',current_date,interval '1 day') AS days(day)
      LEFT JOIN sales ON sales.sale_day=days.day::date
      GROUP BY days.day ORDER BY days.day`,[seller.id]),
    db.query(`SELECT oi.product_id,oi.product_name,
        COALESCE(SUM(oi.unit_price_kobo*oi.quantity),0)::text AS revenue_kobo,
        COALESCE(SUM(oi.quantity),0)::int AS units_sold
      FROM market_order_items oi JOIN market_orders o ON o.id=oi.order_id
      WHERE oi.seller_id=$1 AND o.payment_status='paid' AND o.created_at>=now()-interval '30 days'
      GROUP BY oi.product_id,oi.product_name ORDER BY SUM(oi.unit_price_kobo*oi.quantity) DESC LIMIT 5`,[seller.id]),
    db.query('SELECT COALESCE(SUM(views),0)::text AS total_views FROM market_products WHERE seller_id=$1',[seller.id])
  ]);
  const questions=await db.query(`SELECT q.id,q.question,q.answer,q.status,q.created_at,p.name AS product_name,
      split_part(u.full_name,' ',1) AS asker_name
    FROM market_product_questions q JOIN market_products p ON p.id=q.product_id JOIN market_users u ON u.id=q.asker_id
    WHERE p.seller_id=$1 AND q.status IN ('open','answered')
    ORDER BY CASE WHEN q.status='open' THEN 0 ELSE 1 END,q.created_at DESC LIMIT 100`,[seller.id]);
  const variants=await db.query(`SELECT id,product_id,label,sku,price_kobo,stock_qty
    FROM market_product_variants WHERE seller_id=$1 AND is_active=true ORDER BY product_id,label`,[seller.id]);
  const variantMap=new Map();
  for(const variant of variants.rows){
    if(!variantMap.has(variant.product_id))variantMap.set(variant.product_id,[]);
    variantMap.get(variant.product_id).push(variant);
  }
  for(const product of products.rows) product.variants=variantMap.get(product.id)||[];
  const totals = await db.query(`SELECT COALESCE(sum(net_kobo),0) AS net_total,COALESCE(sum(net_kobo) FILTER(WHERE status IN ('pending','approved','held')),0) AS outstanding,COALESCE(sum(net_kobo) FILTER(WHERE status='paid'),0) AS paid FROM market_payouts WHERE seller_id=$1`,[seller.id]);
  const growthProfile = await ensureGrowthProfile(db,user.id);
  return {
    seller: sellerPublic(seller), products: products.rows, orders: orders.rows,
    payouts: payouts.rows, disputes: disputes.rows, questions:questions.rows, totals: totals.rows[0],
    analytics: {
      summary: salesSummary.rows[0],
      total_views: Number(totalViews.rows[0]?.total_views||0),
      sales_trend: salesTrend.rows,
      top_products: topProducts.rows
    },
    referral_url: 'https://market.ethandigitalacademy.org/?ref=' + encodeURIComponent(growthProfile.referral_code)
  };
}

function sellerPublic(s) {
  return { id:s.id,store_name:s.store_name,slug:s.slug,description:s.description,phone:s.phone,whatsapp:s.whatsapp,business_type:s.business_type,city:s.city,state:s.state,seller_status:s.seller_status,bank_name:s.bank_name,bank_code:decryptField(s.bank_code),account_number:decryptField(s.account_number),account_name:s.account_name,commission_bps:s.commission_bps };
}

async function saveSellerProfile(db, req, body) {
  const user = await requireRole(req, db, ['seller','admin','super_admin']);
  const seller = await getSellerByUser(db,user.id,false);
  const { rows } = await db.query(
    `UPDATE market_sellers SET description=$2,phone=$3,whatsapp=$4,city=$5,state=$6,bank_name=$7,bank_code=$8,
      account_number=$9,account_name=$10,updated_at=now() WHERE id=$1 RETURNING *`,
    [seller.id,text(body.description,1500),text(body.phone,40),text(body.whatsapp,40),text(body.city,80),text(body.state,80),text(body.bank_name,120),encryptField(body.bank_code),encryptField(body.account_number),text(body.account_name,120)]
  );
  await audit(db,user.id,'SELLER_PROFILE_UPDATED','seller',seller.id);
  return { seller: sellerPublic(rows[0]) };
}

async function saveProduct(db, req, body) {
  const user = await requireRole(req, db, ['seller','admin','super_admin']);
  const seller = await getSellerByUser(db,user.id,true);
  const name = text(body.name,180);
  const description = text(body.description,5000);
  const price = money(body.price_kobo);
  const type = body.product_type === 'digital' ? 'digital' : 'physical';
  const variantsSupplied=Array.isArray(body.variants);
  const variants=variantsSupplied?body.variants:[];
  if(variants.length>30) throw new HttpError(400,'A product can have up to 30 variations.');
  if(type==='digital'&&variants.length) throw new HttpError(400,'Digital products cannot have physical stock variations.');
  const variantLabels=new Set();
  for(const item of variants){
    const label=text(item?.label,100).trim(),stockQty=Number(item?.stock_qty);
    const variantPrice=item?.price_kobo===null||item?.price_kobo===''||item?.price_kobo===undefined?null:money(item.price_kobo);
    if(!label) throw new HttpError(400,'Every variation needs an option label.');
    if(variantLabels.has(label.toLowerCase())) throw new HttpError(400,'Variation labels must be unique within a product.');
    variantLabels.add(label.toLowerCase());
    if(!Number.isInteger(stockQty)||stockQty<0||stockQty>1000000) throw new HttpError(400,'Variation stock must be a whole number between 0 and 1,000,000.');
    if(variantPrice!==null&&variantPrice<100) throw new HttpError(400,'Variation prices must be at least ₦1.');
  }
  const stock = type === 'digital' ? 999999 : variants.length ? variants.reduce((sum,item)=>sum+Number(item.stock_qty),0) : Math.min(Math.max(parseInt(body.stock_qty,10)||0,0),100000);
  const imageUrl = text(body.image_url,1000);
  if (name.length < 3 || description.length < 10 || price < 100) throw new HttpError(400,'Add a product name, a useful description and a price of at least ₦1.');
  if (body.compare_at_kobo && money(body.compare_at_kobo) < price) throw new HttpError(400,'The previous price must be higher than the selling price.');
  if (imageUrl && !/^https:\/\//i.test(imageUrl)) throw new HttpError(400,'Product image must use a secure HTTPS image URL.');
  if (type === 'digital' && body.digital_delivery_url && !/^https:\/\//i.test(String(body.digital_delivery_url))) throw new HttpError(400,'Digital delivery links must use HTTPS.');
  if (type === 'physical' && stock < 1 && !variants.length) throw new HttpError(400,'A physical product needs stock, or add variations with their own stock quantities.');
  const category = await db.query('SELECT id FROM market_categories WHERE id::text=$1 OR slug=$1 LIMIT 1',[text(body.category_id,100)]);
  if (!category.rows.length) throw new HttpError(400,'Choose a valid product category.');
  const productId = text(body.id,80);
  if (productId) {
    const { rows } = await db.query(
      `UPDATE market_products SET category_id=$3,name=$4,description=$5,product_type=$6,price_kobo=$7,
        compare_at_kobo=$8,image_url=$9,sku=$10,stock_qty=$11,digital_delivery_url=$12,status='pending',featured=false,updated_at=now()
       WHERE id=$1 AND seller_id=$2 RETURNING id,name,status,price_kobo,product_type,stock_qty`,
      [productId,seller.id,category.rows[0].id,name,description,type,price,body.compare_at_kobo?money(body.compare_at_kobo):null,imageUrl,text(body.sku,80),stock,type==='digital'?text(body.digital_delivery_url,1500):'']
    );
    if (!rows.length) throw new HttpError(404,'Product was not found in your store.');
    if(variantsSupplied) await syncProductVariants(db,seller.id,productId,variants,stock);
    await audit(db,user.id,'PRODUCT_UPDATED','product',productId);
    return { product: rows[0] };
  }
  const slug = slugify(name) + '-' + crypto.randomBytes(2).toString('hex');
  const { rows } = await db.query(
    `INSERT INTO market_products(seller_id,category_id,name,slug,description,product_type,price_kobo,compare_at_kobo,image_url,sku,stock_qty,digital_delivery_url,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending') RETURNING id,name,status,price_kobo,product_type,stock_qty`,
    [seller.id,category.rows[0].id,name,slug,description,type,price,body.compare_at_kobo?money(body.compare_at_kobo):null,imageUrl,text(body.sku,80),stock,type==='digital'?text(body.digital_delivery_url,1500):'']
  );
  if(variantsSupplied) await syncProductVariants(db,seller.id,rows[0].id,variants,stock);
  await audit(db,user.id,'PRODUCT_SUBMITTED','product',rows[0].id);
  return { product: rows[0] };
}

async function syncProductVariants(db,sellerId,productId,variants,fallbackStock=0) {
  if(!Array.isArray(variants)) return null;
  if(variants.length>30) throw new HttpError(400,'A product can have up to 30 variations.');
  const cleaned=[],labels=new Set();
  for(const raw of variants){
    const label=text(raw?.label,100).trim(),sku=text(raw?.sku,80).trim(),stock=Number(raw?.stock_qty);
    const price=raw?.price_kobo===null||raw?.price_kobo===''||raw?.price_kobo===undefined?null:money(raw.price_kobo);
    const id=text(raw?.id,80);
    if(!label) throw new HttpError(400,'Every variation needs an option label, such as Black / Medium.');
    if(!Number.isInteger(stock)||stock<0||stock>1000000) throw new HttpError(400,'Variation stock must be a whole number from 0 to 1,000,000.');
    if(price!==null&&price<100) throw new HttpError(400,'Variation prices must be at least ₦1.');
    if(id&&!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400,'A variation identifier is invalid.');
    if(labels.has(label.toLowerCase())) throw new HttpError(400,'Variation labels must be unique within a product.');
    labels.add(label.toLowerCase());cleaned.push({id,label,sku,stock,price});
  }
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    const productLock=await client.query('SELECT id FROM market_products WHERE id=$1 AND seller_id=$2 FOR UPDATE',[productId,sellerId]);
    if(!productLock.rows.length) throw new HttpError(404,'Product was not found in your store.');
    await client.query('UPDATE market_product_variants SET is_active=false,updated_at=now() WHERE product_id=$1 AND seller_id=$2',[productId,sellerId]);
    for(const variant of cleaned){
      if(variant.id){
        const updated=await client.query(`UPDATE market_product_variants SET label=$4,sku=$5,price_kobo=$6,stock_qty=$7,is_active=true,updated_at=now()
          WHERE id=$1 AND product_id=$2 AND seller_id=$3 RETURNING id`,
          [variant.id,productId,sellerId,variant.label,variant.sku,variant.price,variant.stock]);
        if(!updated.rows.length) throw new HttpError(400,'A variation does not belong to this product.');
      }else{
        await client.query(`INSERT INTO market_product_variants(product_id,seller_id,label,sku,price_kobo,stock_qty)
          VALUES($1,$2,$3,$4,$5,$6)`,
          [productId,sellerId,variant.label,variant.sku,variant.price,variant.stock]);
      }
    }
    const total=cleaned.length?cleaned.reduce((sum,item)=>sum+item.stock,0):Math.max(0,Number(fallbackStock)||0);
    await client.query('UPDATE market_products SET stock_qty=$3,updated_at=now() WHERE id=$1 AND seller_id=$2',[productId,sellerId,total]);
    await client.query('COMMIT');
    return {count:cleaned.length,stock_qty:total};
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
}

async function updateSellerInventory(db,req,body) {
  const user=await requireRole(req,db,['seller','admin','super_admin']);
  const seller=await getSellerByUser(db,user.id,true);
  const id=text(body.id,80);
  const stock=Number(body.stock_qty);
  if(!id||!Number.isInteger(stock)||stock<0||stock>1000000) throw new HttpError(400,'Enter a whole-number stock quantity between 0 and 1,000,000.');
  const result=await db.query("UPDATE market_products SET stock_qty=$3,updated_at=now() WHERE id=$1 AND seller_id=$2 AND product_type='physical' AND NOT EXISTS(SELECT 1 FROM market_product_variants v WHERE v.product_id=market_products.id AND v.is_active=true) RETURNING id,name,stock_qty,status",[id,seller.id,stock]);
  if(!result.rows.length) throw new HttpError(404,'Physical product was not found in your store.');
  await audit(db,user.id,'PRODUCT_STOCK_UPDATED','product',id,{stock_qty:stock});
  if(stock<=5) await createNotification(db,user.id,{
    type:'inventory_low',title:stock===0?'Product is out of stock':'Low stock reminder',
    message:stock===0?result.rows[0].name+' is now out of stock. Update its quantity when inventory is replenished.':result.rows[0].name+' has only '+stock+' item(s) left. Consider replenishing your inventory.',
    target_tab:'products',dedupe_key:'seller-stock-alert:'+id+':'+new Date().toISOString().slice(0,10),
    metadata:{product_id:id,stock_qty:stock}
  });
  return {product:result.rows[0]};
}

async function updateSellerVariantInventory(db,req,body) {
  const user=await requireRole(req,db,['seller','admin','super_admin']);
  const seller=await getSellerByUser(db,user.id,true);
  const id=text(body.variant_id,80),stock=Number(body.stock_qty);
  if(!id||!Number.isInteger(stock)||stock<0||stock>1000000) throw new HttpError(400,'Enter a whole-number variation stock quantity from 0 to 1,000,000.');
  const client=await db.connect();
  let result;
  try{
    await client.query('BEGIN');
    const target=await client.query('SELECT product_id FROM market_product_variants WHERE id=$1 AND seller_id=$2 AND is_active=true',[id,seller.id]);
    if(!target.rows.length) throw new HttpError(404,'This product variation was not found in your store.');
    const productId=target.rows[0].product_id;
    const locked=await client.query('SELECT id FROM market_products WHERE id=$1 AND seller_id=$2 FOR UPDATE',[productId,seller.id]);
    if(!locked.rows.length) throw new HttpError(404,'The product for this variation was not found in your store.');
    const updated=await client.query(`UPDATE market_product_variants SET stock_qty=$3,updated_at=now()
      WHERE id=$1 AND seller_id=$2 AND is_active=true RETURNING id,product_id,label,stock_qty`,[id,seller.id,stock]);
    if(!updated.rows.length) throw new HttpError(409,'This product variation changed while inventory was being updated. Refresh and try again.');
    const total=await client.query('SELECT COALESCE(SUM(stock_qty),0)::int AS stock_qty FROM market_product_variants WHERE product_id=$1 AND seller_id=$2 AND is_active=true',[productId,seller.id]);
    await client.query('UPDATE market_products SET stock_qty=$2,updated_at=now() WHERE id=$1 AND seller_id=$3',[productId,total.rows[0].stock_qty,seller.id]);
    await client.query('COMMIT');
    result={variant:updated.rows[0],product_stock_qty:total.rows[0].stock_qty};
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
  await audit(db,user.id,'PRODUCT_VARIANT_STOCK_UPDATED','product_variant',id,{stock_qty:stock});
  if(stock<=5) await createNotification(db,user.id,{
    type:'inventory_low',title:stock===0?'Product option is out of stock':'Low option stock reminder',
    message:result.variant.label+' has '+stock+' item(s) left. Review this option’s inventory.',
    target_tab:'products',dedupe_key:'seller-variant-stock-alert:'+id+':'+new Date().toISOString().slice(0,10),
    metadata:{product_id:result.variant.product_id,variant_id:id,variant_label:result.variant.label,stock_qty:stock}
  });
  return result;
}

async function bulkSaveProducts(db,req,body) {
  const user=await requireRole(req,db,['seller','admin','super_admin']);
  await getSellerByUser(db,user.id,true);
  const items=Array.isArray(body.products)?body.products:[];
  if(!items.length||items.length>30) throw new HttpError(400,'Import between 1 and 30 products per CSV upload.');
  const imported=[],errors=[];
  for(let i=0;i<items.length;i++) {
    try {
      if(!items[i]||typeof items[i]!=='object'||Array.isArray(items[i])) throw new HttpError(400,'Invalid product row.');
      const result=await saveProduct(db,req,items[i]);
      imported.push({row:i+2,id:result.product.id,name:result.product.name,status:result.product.status});
    } catch(error) {
      errors.push({row:i+2,message:error.status?error.message:'This row could not be imported.'});
    }
  }
  await audit(db,user.id,'PRODUCTS_BULK_IMPORTED','seller',user.id,{imported:imported.length,failed:errors.length});
  return {imported:imported.length,failed:errors.length,products:imported,errors};
}
async function checkout(db, req, body) {
  if (!monnifyConfigured()) throw new HttpError(503,'Monnify secure checkout is not configured yet. Marketplace browsing and seller registration remain available.');
  const user = await requireRole(req, db, ['buyer','seller','admin','super_admin']);
  await rateLimit(db, 'checkout', user.id, 10, 60);
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length || items.length > 30) throw new HttpError(400,'Your cart is empty or contains too many products.');
  const cartLines = new Map();
  for (const item of items) {
    const productId=text(item.product_id,80),variantId=text(item.variant_id,80),quantity=Math.min(Math.max(parseInt(item.quantity,10)||0,0),20);
    if(!/^[0-9a-f-]{36}$/i.test(productId)||quantity<1) throw new HttpError(400,'Your cart contains an invalid item.');
    if(variantId&&!/^[0-9a-f-]{36}$/i.test(variantId)) throw new HttpError(400,'A product variation in your cart is invalid.');
    const key=productId+':'+variantId,line=cartLines.get(key)||{product_id:productId,variant_id:variantId,quantity:0};
    line.quantity+=quantity;
    if(line.quantity>20) throw new HttpError(400,'A product variation quantity cannot exceed 20 per checkout.');
    cartLines.set(key,line);
  }
  const dbClient = await db.connect();
  let order;
  try {
    await dbClient.query('BEGIN');
    await dbClient.query(
      `UPDATE market_promo_redemptions r SET status='expired' FROM market_orders o
       WHERE r.order_id=o.id AND r.status='reserved' AND (o.payment_status<>'pending' OR o.created_at<now()-interval '30 minutes')`
    );
    await dbClient.query("UPDATE market_orders SET payment_status='failed',status='cancelled',updated_at=now() WHERE payment_status='pending' AND created_at < now()-interval '30 minutes'");
    const ids=[...new Set([...cartLines.values()].map(line=>line.product_id))];
    const {rows:products}=await dbClient.query(
      `SELECT p.*,s.id AS approved_seller_id,s.commission_bps,s.store_name FROM market_products p
       JOIN market_sellers s ON s.id=p.seller_id WHERE p.id=ANY($1::uuid[]) AND p.status='active' AND s.seller_status='approved' FOR UPDATE OF p`,[ids]
    );
    if(products.length!==ids.length) throw new HttpError(409,'One or more products are no longer available. Refresh your cart.');
    const productMap=new Map(products.map(product=>[product.id,product]));
    const {rows:variantRows}=await dbClient.query(
      `SELECT id,product_id,label,sku,price_kobo,stock_qty FROM market_product_variants
       WHERE product_id=ANY($1::uuid[]) AND is_active=true FOR UPDATE`,[ids]
    );
    const variantMap=new Map();
    for(const variant of variantRows){
      if(!variantMap.has(variant.product_id))variantMap.set(variant.product_id,[]);
      variantMap.get(variant.product_id).push(variant);
    }
    let subtotal=0,physical=false,marketplaceFee=0;
    const orderId=crypto.randomUUID();
    const orderNumber='EM-'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'-'+crypto.randomBytes(3).toString('hex').toUpperCase();
    const ref='EM'+Date.now().toString()+crypto.randomBytes(5).toString('hex').toUpperCase();
    const itemSnapshots=[];
    for(const line of cartLines.values()){
      const p=productMap.get(line.product_id),quantity=line.quantity;
      const productVariants=variantMap.get(p.id)||[];
      let variant=null;
      if(line.variant_id){
        variant=productVariants.find(option=>option.id===line.variant_id)||null;
        if(!variant) throw new HttpError(409,`The selected option for ${p.name} is no longer available. Refresh your cart.`);
      }else if(productVariants.length){
        throw new HttpError(400,`Choose an option for ${p.name} before checkout.`);
      }
      if(variant&&p.product_type!=='physical') throw new HttpError(400,'Only physical products can have stock variations.');
      const unitPrice=Number(variant?.price_kobo||p.price_kobo);
      if(p.product_type==='physical'){
        const reserved=variant
          ? await dbClient.query(`SELECT COALESCE(sum(oi.quantity),0)::int AS quantity FROM market_order_items oi
              JOIN market_orders o ON o.id=oi.order_id WHERE oi.variant_id=$1 AND o.payment_status='pending'
                AND o.created_at>=now()-interval '30 minutes'`,[variant.id])
          : await dbClient.query(`SELECT COALESCE(sum(oi.quantity),0)::int AS quantity FROM market_order_items oi
              JOIN market_orders o ON o.id=oi.order_id WHERE oi.product_id=$1 AND oi.variant_id IS NULL
                AND oi.product_type='physical' AND o.payment_status='pending'
                AND o.created_at>=now()-interval '30 minutes'`,[p.id]);
        const stock=Number(variant?variant.stock_qty:p.stock_qty);
        const available=stock-Number(reserved.rows[0]?.quantity||0);
        if(available<quantity) throw new HttpError(409,`${p.name}${variant?' · '+variant.label:''} has only ${Math.max(available,0)} item(s) currently available.`);
      }
      subtotal+=unitPrice*quantity;
      if(p.product_type==='physical')physical=true;
      const commission=Math.round(unitPrice*quantity*Number(p.commission_bps)/10000);
      marketplaceFee+=commission;
      itemSnapshots.push({p,variant,quantity,unitPrice,commission,net:unitPrice*quantity-commission});
    }
    if (!Number.isSafeInteger(subtotal) || subtotal < 100) throw new HttpError(400,'The cart total is invalid.');
    const settings = await getSettings(dbClient);
    const shipping = physical ? money(settings.physical_shipping_kobo ?? 200000) : 0;
    const promoCode=text(body.promo_code,40).toUpperCase();
    const promo=promoCode?await resolvePromo(dbClient,user,promoCode,subtotal,marketplaceFee,true):null;
    const discount=promo?promo.discount_kobo:0;
    const growthProfile=await ensureGrowthProfile(dbClient,user.id,{campaign_slug:text(body.campaign_slug,100),source:text(body.utm_source,80),medium:text(body.utm_medium,80)});
    const attribution=await dbClient.query(
      `SELECT a.referrer_user_id,g.affiliate_status,g.affiliate_commission_bps
       FROM market_growth_attributions a JOIN market_growth_profiles g ON g.user_id=a.referrer_user_id
       WHERE a.referred_user_id=$1 LIMIT 1`,[user.id]
    );
    const affiliateUser=attribution.rows[0]?.affiliate_status==='approved'?attribution.rows[0].referrer_user_id:null;
    const campaignSlug=text(body.campaign_slug,100)||growthProfile.first_campaign_slug||'';
    const total = subtotal + shipping - discount;
    const recipient = text(body.recipient_name || user.full_name,120);
    const phone = text(body.phone || user.phone,40);
    const address = {
      line1:text(body.address_line1,180),line2:text(body.address_line2,180),city:text(body.city,80),
      state:text(body.state,80),postal_code:text(body.postal_code,30),country:'Nigeria'
    };
    if (physical && (!recipient || !phone || !address.line1 || !address.city || !address.state)) throw new HttpError(400,'Complete the delivery name, phone, street, city and state for physical items.');
    await dbClient.query(
      `INSERT INTO market_orders(id,order_number,buyer_id,buyer_email,recipient_name,phone,subtotal_kobo,shipping_kobo,total_kobo,payment_provider,payment_reference,shipping_address,buyer_note,discount_kobo,promo_code,campaign_slug,affiliate_user_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'monnify',$10,$11,$12,$13,$14,$15,$16)`,
      [orderId,orderNumber,user.id,user.email,recipient,phone,subtotal,shipping,total,ref,JSON.stringify(address),text(body.buyer_note,1000),discount,promo?.code||'',campaignSlug,affiliateUser]
    );
    for (const it of itemSnapshots) {
      await dbClient.query(
        `INSERT INTO market_order_items(order_id,product_id,variant_id,variant_label,variant_sku,seller_id,product_name,product_type,quantity,unit_price_kobo,commission_kobo,seller_net_kobo,digital_delivery_url,fulfillment_status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [orderId,it.p.id,it.variant?.id||null,it.variant?.label||'',it.variant?.sku||'',it.p.seller_id,it.p.name,it.p.product_type,it.quantity,it.unitPrice,it.commission,it.net,it.p.product_type==='digital'?text(it.p.digital_delivery_url,1500):'',it.p.product_type==='digital'?'delivered':'unfulfilled']
      );
    }
    await dbClient.query("INSERT INTO market_payments(order_id,provider,reference,amount_kobo) VALUES($1,'monnify',$2,$3)",[orderId,ref,total]);
    if(promo) await dbClient.query(
      `INSERT INTO market_promo_redemptions(promo_id,order_id,user_id,discount_kobo,status)
       VALUES($1,$2,$3,$4,'reserved')`,[promo.id,orderId,user.id,discount]
    );
    await trackGrowthEvent(dbClient,{event_type:'checkout_started',user_id:user.id,order_id:orderId,campaign_slug:campaignSlug,metadata:{promo_code:promo?.code||'',affiliate_attributed:!!affiliateUser}});
    await dbClient.query('COMMIT');
    order={id:orderId,order_number:orderNumber,reference:ref,total_kobo:total,email:user.email,customer_name:recipient,discount_kobo:discount,promo_code:promo?.code||''};
  } catch(e) { await dbClient.query('ROLLBACK'); throw e; }
  finally { dbClient.release(); }

  let callbackBase=String(process.env.MARKET_PUBLIC_URL||'https://market.ethandigitalacademy.org').trim();
  while(callbackBase.endsWith('/')) callbackBase=callbackBase.slice(0,-1);
  const callback=callbackBase+'/?payment=verify&reference='+encodeURIComponent(order.reference);
  try {
    const gateway = await monnifyRequest('/api/v1/merchant/transactions/init-transaction', {
      method:'POST',
      body:{
        amount:Number((order.total_kobo/100).toFixed(2)),
        customerName:order.customer_name,
        customerEmail:order.email,
        paymentReference:order.reference,
        paymentDescription:'ETHAN MARKET order '+order.order_number,
        currencyCode:'NGN',
        contractCode:process.env.MONNIFY_CONTRACT_CODE,
        redirectUrl:callback,
        paymentMethods:['CARD','ACCOUNT_TRANSFER']
      }
    });
    if (!gateway?.checkoutUrl) throw new HttpError(502,'Monnify did not return a secure checkout link.');
    await db.query("UPDATE market_payments SET gateway_payload=$2::jsonb WHERE reference=$1 AND provider='monnify'",[order.reference,JSON.stringify({transactionReference:gateway.transactionReference||'',paymentReference:order.reference})]);
    return { checkout_url:gateway.checkoutUrl,reference:order.reference,order_number:order.order_number,total_kobo:order.total_kobo };
  } catch (error) {
    await db.query("UPDATE market_orders SET payment_status='failed',status='cancelled',updated_at=now() WHERE id=$1 AND payment_status='pending'",[order.id]);
    await db.query("UPDATE market_payments SET status='failed' WHERE reference=$1 AND status='pending'",[order.reference]);
    await db.query("UPDATE market_promo_redemptions SET status='failed' WHERE order_id=$1 AND status='reserved'",[order.id]);
    throw error;
  }
}

async function paystack(path, options={}) {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new HttpError(503,'Paystack is not configured yet.');
  let response;
  try {
    response = await fetch('https://api.paystack.co' + path, {
      method:options.method||'GET',
      headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',Accept:'application/json'},
      body:options.body?JSON.stringify(options.body):undefined,
      signal:AbortSignal.timeout(15000)
    });
  } catch { throw new HttpError(502,'Payment provider is temporarily unavailable.'); }
  const payload = await response.json().catch(()=>({}));
  if (!response.ok || !payload.status) throw new HttpError(502,payload.message || 'Payment provider could not complete the request.');
  return payload;
}

let monnifyTokenCache = { token:'', expiresAt:0 };
async function monnifyAccessToken() {
  if(monnifyTokenCache.token && monnifyTokenCache.expiresAt>Date.now()+30000) return monnifyTokenCache.token;
  if(!monnifyConfigured()) throw new HttpError(503,'Monnify API credentials and contract code are not configured.');
  let response;
  try {
    const basic=Buffer.from(process.env.MONNIFY_API_KEY+':'+process.env.MONNIFY_SECRET_KEY).toString('base64');
    response=await fetch(monnifyBaseUrl()+'/api/v1/auth/login',{
      method:'POST',headers:{Authorization:'Basic '+basic,'Content-Type':'application/json',Accept:'application/json'},
      signal:AbortSignal.timeout(15000)
    });
  } catch { throw new HttpError(502,'Monnify authentication service is temporarily unavailable.'); }
  const payload=await response.json().catch(()=>({}));
  const token=payload?.responseBody?.accessToken;
  if(!response.ok||payload?.requestSuccessful!==true||!token) throw new HttpError(502,'Monnify authentication failed. Check the API key and secret in Vercel.');
  const seconds=Math.max(60,Number(payload.responseBody.expiresIn)||3600);
  monnifyTokenCache={token,expiresAt:Date.now()+Math.max(60,seconds-120)*1000};
  return token;
}

async function monnifyRequest(path,options={}) {
  const token=await monnifyAccessToken();
  let response;
  try {
    response=await fetch(monnifyBaseUrl()+path,{
      method:options.method||'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json'},
      body:options.body?JSON.stringify(options.body):undefined,signal:AbortSignal.timeout(15000)
    });
  } catch { throw new HttpError(502,'Monnify payment service is temporarily unavailable.'); }
  const payload=await response.json().catch(()=>({}));
  if(!response.ok||payload?.requestSuccessful!==true||!payload?.responseBody) {
    throw new HttpError(502,payload?.responseMessage||'Monnify could not complete the payment request.');
  }
  return payload.responseBody;
}

async function verifyMonnifyTransaction(reference) {
  const result=await monnifyRequest('/api/v2/merchant/transactions/query?paymentReference='+encodeURIComponent(reference));
  const returnedReference=text(result.paymentReference,120);
  const status=String(result.paymentStatus||'').toUpperCase();
  if(returnedReference!==reference) throw new HttpError(409,'Monnify returned a different payment reference.');
  if(status!=='PAID') throw new HttpError(409,'Monnify has not confirmed this payment as PAID yet. Current status: '+(status||'unknown')+'.');
  const amountNaira=Number(result.amountPaid);
  if(!Number.isFinite(amountNaira)||amountNaira<=0) throw new HttpError(409,'Monnify did not return a valid amount received.');
  return {provider:'monnify',status:'success',reference:returnedReference,amount:Math.round(amountNaira*100),
    currency:String(result.currencyCode||result.currency||''),gatewayPayload:result};
}

async function finalizePaid(db, transaction) {
  if (!transaction || transaction.status !== 'success' || !transaction.reference) throw new HttpError(400,'This transaction has not been confirmed as successful.');
  const client = await db.connect();
  let orderInfo;
  try {
    await client.query('BEGIN');
    const provider=String(transaction.provider||'paystack');
    const { rows } = await client.query('SELECT * FROM market_orders WHERE payment_reference=$1 OR paystack_reference=$1 FOR UPDATE',[String(transaction.reference)]);
    if (!rows.length) throw new HttpError(404,'No ETHAN MARKET order matches this payment reference.');
    const order = rows[0];
    if(String(order.payment_provider||'paystack')!==provider) throw new HttpError(409,'This payment reference belongs to a different payment provider.');
    const payment=await client.query('SELECT provider,amount_kobo FROM market_payments WHERE reference=$1 FOR UPDATE',[String(transaction.reference)]);
    if(payment.rows[0]&&(payment.rows[0].provider!==provider||Number(payment.rows[0].amount_kobo)!==Number(order.total_kobo))) throw new HttpError(409,'The payment ledger does not match this order.');
    if (Number(transaction.amount) !== Number(order.total_kobo) || String(transaction.currency).toUpperCase() !== 'NGN') throw new HttpError(400,'The payment amount or currency does not match this order.');
    const productIdsResult=await client.query(`SELECT DISTINCT product_id FROM market_order_items
      WHERE order_id=$1 AND product_type='physical' AND product_id IS NOT NULL ORDER BY product_id`,[order.id]);
    const productIds=productIdsResult.rows.map(row=>row.product_id);
    if(productIds.length) await client.query('SELECT id FROM market_products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[productIds]);
    if (order.payment_status !== 'paid') {
      await client.query("UPDATE market_orders SET payment_status='paid',status=CASE WHEN NOT EXISTS(SELECT 1 FROM market_order_items WHERE order_id=$1 AND product_type='physical') THEN 'delivered' ELSE 'processing' END,payment_verified_at=now(),updated_at=now() WHERE id=$1",[order.id]);
      await client.query("UPDATE market_payments SET status='success',gateway_payload=$2::jsonb,verified_at=now() WHERE reference=$1 AND provider=$3",[String(transaction.reference),JSON.stringify(transaction.gatewayPayload||transaction),provider]);
      const { rows:changed } = await client.query('UPDATE market_order_items SET stock_deducted=true WHERE order_id=$1 AND product_type=\'physical\' AND stock_deducted=false RETURNING product_id,variant_id,quantity',[order.id]);
      for (const row of changed) if (row.product_id) {
        if(row.variant_id){
          await client.query('UPDATE market_product_variants SET stock_qty=GREATEST(stock_qty-$2,0),updated_at=now() WHERE id=$1',[row.variant_id,row.quantity]);
          await client.query(`UPDATE market_products SET stock_qty=CASE
            WHEN EXISTS(SELECT 1 FROM market_product_variants WHERE product_id=$1 AND is_active=true)
            THEN COALESCE((SELECT SUM(stock_qty) FROM market_product_variants WHERE product_id=$1 AND is_active=true),0)
            ELSE stock_qty END,updated_at=now() WHERE id=$1`,[row.product_id]);
        }else{
          await client.query('UPDATE market_products SET stock_qty=GREATEST(stock_qty-$2,0),updated_at=now() WHERE id=$1',[row.product_id,row.quantity]);
        }
      }
      const holdSetting=await client.query("SELECT value FROM market_settings WHERE key='seller_payout_hold_days'");
      const holdDays=Math.min(30,Math.max(1,Number(holdSetting.rows[0]?.value)||7));
      await client.query(
        `INSERT INTO market_payouts(order_item_id,order_id,seller_id,gross_kobo,commission_kobo,net_kobo,eligible_at,hold_reason)
         SELECT id,order_id,seller_id,unit_price_kobo*quantity,commission_kobo,seller_net_kobo,
           CASE WHEN product_type='digital' THEN now()+($2::text||' days')::interval ELSE NULL END,
           CASE WHEN product_type='digital' THEN 'Digital product protection period' ELSE 'Awaiting buyer delivery confirmation' END
         FROM market_order_items WHERE order_id=$1
         ON CONFLICT(order_item_id) DO NOTHING`,[order.id,holdDays]
      );
      await client.query("UPDATE market_promo_redemptions SET status='redeemed',redeemed_at=now() WHERE order_id=$1 AND status='reserved'",[order.id]);
      await client.query(
        `UPDATE market_growth_attributions SET status=CASE WHEN status='seller_approved' THEN status ELSE 'first_order' END,
         first_order_id=COALESCE(first_order_id,$2),first_order_at=COALESCE(first_order_at,now())
         WHERE referred_user_id=$1 AND first_order_at IS NULL`,[order.buyer_id,order.id]
      );
      const referralOwner=await client.query(
        `SELECT o.affiliate_user_id AS referrer_user_id,g.referral_code,g.affiliate_status,g.affiliate_commission_bps
         FROM market_orders o JOIN market_growth_profiles g ON g.user_id=o.affiliate_user_id
         WHERE o.id=$1 AND o.affiliate_user_id IS NOT NULL LIMIT 1`,[order.id]
      );
      if(referralOwner.rows[0]?.affiliate_status==='approved' && Number(referralOwner.rows[0].affiliate_commission_bps)>0) {
        const totals=await client.query(
          `SELECT COALESCE(sum(unit_price_kobo*quantity),0)::bigint AS sales,
           COALESCE(sum(commission_kobo),0)::bigint AS fee FROM market_order_items WHERE order_id=$1`,[order.id]
        );
        const sales=Number(totals.rows[0].sales||0),fee=Number(totals.rows[0].fee||0);
        const promoDiscount=Number((await client.query('SELECT discount_kobo FROM market_orders WHERE id=$1',[order.id])).rows[0]?.discount_kobo||0);
        const availableFee=Math.max(0,fee-promoDiscount);
        const affiliateCommission=Math.min(availableFee,Math.round(fee*Number(referralOwner.rows[0].affiliate_commission_bps)/10000));
        if(affiliateCommission>0) {
          await client.query(
            `INSERT INTO market_affiliate_conversions(affiliate_user_id,order_id,referral_code,sale_kobo,marketplace_fee_kobo,commission_kobo)
             VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(order_id) DO NOTHING`,
            [referralOwner.rows[0].referrer_user_id,order.id,referralOwner.rows[0].referral_code,sales,fee,affiliateCommission]
          );
          await createNotification(client,referralOwner.rows[0].referrer_user_id,{
            type:'affiliate_conversion',title:'A referral made a purchase',
            message:`A customer you referred completed order ${order.order_number}. Your affiliate reward is awaiting review.`,
            target_tab:'growth',dedupe_key:`affiliate-sale:${order.id}`,metadata:{order_id:order.id,order_number:order.order_number,commission_kobo:affiliateCommission}
          });
        }
      }
      await trackGrowthEvent(client,{event_type:'purchase',user_id:order.buyer_id,order_id:order.id,campaign_slug:order.campaign_slug||'',metadata:{total_kobo:Number(order.total_kobo),promo_code:order.promo_code||''}});
      await createNotification(client,order.buyer_id,{
        type:'order_paid',title:'Payment confirmed',
        message:`Your payment for order ${order.order_number} was confirmed. Your purchases are now available in your order history.`,
        target_tab:'orders',dedupe_key:`buyer-order-paid:${order.id}`,metadata:{order_id:order.id,order_number:order.order_number}
      });
      const {rows:orderedItems}=await client.query(
        `SELECT oi.id,oi.product_name,oi.quantity,s.user_id AS seller_user_id,s.store_name
         FROM market_order_items oi JOIN market_sellers s ON s.id=oi.seller_id WHERE oi.order_id=$1`,[order.id]
      );
      for(const item of orderedItems) await createNotification(client,item.seller_user_id,{
        type:'new_order',title:'New paid order received',
        message:`You have a new paid order: ${item.product_name} × ${item.quantity}. Open your orders and prepare fulfilment.`,
        target_tab:'orders',dedupe_key:`seller-new-order:${item.id}`,metadata:{order_id:order.id,order_item_id:item.id,order_number:order.order_number,store_name:item.store_name}
      });
    }
    orderInfo={id:order.id,order_number:order.order_number,total_kobo:Number(order.total_kobo),payment_status:'paid'};
    await client.query('COMMIT');
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  return orderInfo;
}

async function verifyPayment(db, req, body) {
  const user = await currentUser(req,db,true);
  const reference = text(body.reference,120);
  if (!reference) throw new HttpError(400,'Payment reference is required.');
  const { rows } = await db.query('SELECT id,buyer_id,payment_provider FROM market_orders WHERE payment_reference=$1 OR paystack_reference=$1 LIMIT 1',[reference]);
  if (!rows.length) throw new HttpError(404,'Order not found.');
  if (rows[0].buyer_id !== user.id && !['admin','super_admin'].includes(user.role)) throw new HttpError(403,'This order does not belong to your account.');
  let order;
  if(String(rows[0].payment_provider||'paystack')==='monnify') {
    const verified=await verifyMonnifyTransaction(reference);
    order=await finalizePaid(db,verified);
  } else {
    const verified=await paystack('/transaction/verify/'+encodeURIComponent(reference));
    order=await finalizePaid(db,{...verified.data,provider:'paystack'});
  }
  return {order};
}

function verifyWebhookSignature(req, rawBody) {
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET || process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return false;
  const sig = String(req.headers['paystack-signature'] || req.headers['x-paystack-signature'] || '');
  if (!sig) return false;
  if (sig.startsWith('t=')) {
    const parts=sig.split(','); const t=parts.find(x=>x.startsWith('t='))?.slice(2);
    const variants=parts.filter(x=>x.startsWith('v1=')).map(x=>x.slice(3).split(':').slice(1).join(':')).filter(Boolean);
    if (!t || !/^\d+$/.test(t) || Math.abs(Date.now()/1000-Number(t))>300) return false;
    const expected=crypto.createHmac('sha512',secret).update(t+'.').update(rawBody).digest('hex');
    return variants.some(v=>safeEqual(v,expected));
  }
  const expected=crypto.createHmac('sha512',secret).update(rawBody).digest('hex');
  return safeEqual(sig,expected);
}

async function readRaw(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  return new Promise((resolve,reject)=>{
    const chunks=[];let size=0;
    req.on('data',chunk=>{size+=chunk.length;if(size>MAX_BODY){reject(new HttpError(413,'Webhook payload is too large.'));req.destroy();return;}chunks.push(chunk);});
    req.on('end',()=>resolve(Buffer.concat(chunks)));
    req.on('error',reject);
  });
}

function verifyMonnifyWebhookSignature(req,rawBody) {
  const secret=process.env.MONNIFY_SECRET_KEY;
  const signature=String(req.headers['monnify-signature']||'').trim();
  if(!secret) return false;
  if(!signature) return monnifyBaseUrl()==='https://sandbox.monnify.com';
  const expected=crypto.createHmac('sha512',secret).update(rawBody).digest('hex');
  return safeEqual(signature.toLowerCase(),expected.toLowerCase());
}

async function webhook(req,res,db) {
  const raw=await readRaw(req);
  let event;
  try { event=JSON.parse(raw.toString('utf8')); } catch { return send(res,400,{error:'Invalid webhook payload.'}); }

  if(event.eventType) {
    if(!verifyMonnifyWebhookSignature(req,raw)) return send(res,401,{error:'Invalid Monnify webhook signature.'});
    if(event.eventType==='SUCCESSFUL_TRANSACTION' && event.eventData?.paymentReference) {
      try {
        const verified=await verifyMonnifyTransaction(text(event.eventData.paymentReference,120));
        await finalizePaid(db,verified);
      } catch(error) {
        console.error('ETHAN MARKET Monnify webhook processing failed:',error.message);
        return send(res,500,{error:'Monnify notification could not be verified. The provider may retry.'});
      }
    }
    return send(res,200,{received:true});
  }

  // Legacy Paystack events are retained only for orders created before migration.
  if(!verifyWebhookSignature(req,raw)) return send(res,401,{error:'Invalid payment webhook signature.'});
  if(event.event==='charge.success' && event.data?.reference) {
    try {
      const verification=await paystack('/transaction/verify/'+encodeURIComponent(event.data.reference));
      await finalizePaid(db,{...verification.data,provider:'paystack'});
    } catch(error) {
      console.error('ETHAN MARKET legacy payment webhook processing failed:',error.message);
      return send(res,500,{error:'Payment webhook could not be processed. The provider may retry.'});
    }
  }
  return send(res,200,{received:true});
}

async function buyerOrders(db,req) {
  const user=await currentUser(req,db,true);
  const {rows}=await db.query(
    `SELECT o.id,o.order_number,o.subtotal_kobo,o.shipping_kobo,o.total_kobo,o.payment_status,o.status,o.created_at,
      json_agg(json_build_object('id',oi.id,'product_id',oi.product_id,'product_name',oi.product_name,'variant_label',oi.variant_label,'variant_sku',oi.variant_sku,'product_type',oi.product_type,'quantity',oi.quantity,
       'unit_price_kobo',oi.unit_price_kobo,'fulfillment_status',oi.fulfillment_status,'tracking_number',oi.tracking_number,'tracking_carrier',oi.tracking_carrier,
       'buyer_confirmed_at',oi.buyer_confirmed_at,'delivered_at',oi.delivered_at,'payout_status',p.status,'payout_eligible_at',p.eligible_at,
       'tracking_events',(SELECT COALESCE(json_agg(json_build_object('status',de.status,'note',de.note,'carrier',de.carrier,'tracking_number',de.tracking_number,'created_at',de.created_at) ORDER BY de.created_at),'[]'::json) FROM market_delivery_events de WHERE de.order_item_id=oi.id),
       'dispute_id',d.id,'dispute_status',d.status,'dispute_reason',d.reason,
       'download_url',CASE WHEN oi.product_type='digital' AND o.payment_status='paid' THEN oi.digital_delivery_url ELSE '' END)
       ORDER BY oi.created_at) AS items
     FROM market_orders o JOIN market_order_items oi ON oi.order_id=o.id
     LEFT JOIN market_payouts p ON p.order_item_id=oi.id
     LEFT JOIN market_disputes d ON d.order_item_id=oi.id
     WHERE o.buyer_id=$1
     GROUP BY o.id ORDER BY o.created_at DESC LIMIT 100`,[user.id]
  );
  return {orders:rows};
}

async function toggleWishlist(db,req,body) {
  const user=await currentUser(req,db,true); const id=text(body.product_id,80);
  const existing=await db.query('DELETE FROM market_wishlists WHERE user_id=$1 AND product_id=$2 RETURNING product_id',[user.id,id]);
  if(!existing.rows.length) await db.query("INSERT INTO market_wishlists(user_id,product_id) SELECT $1,id FROM market_products WHERE id=$2 AND status='active' ON CONFLICT DO NOTHING",[user.id,id]);
  return {saved:!existing.rows.length};
}

async function wishlist(db,req) {
  const user=await currentUser(req,db,true);
  const {rows}=await db.query(
    `SELECT p.id,p.name,p.slug,p.price_kobo,p.image_url,p.product_type,s.store_name FROM market_wishlists w JOIN market_products p ON p.id=w.product_id
     JOIN market_sellers s ON s.id=p.seller_id WHERE w.user_id=$1 AND p.status='active' AND s.seller_status='approved' ORDER BY w.created_at DESC`,[user.id]
  );
  return {products:rows};
}

async function addReview(db,req,body) {
  const user=await requireRole(req,db,['buyer','seller','admin','super_admin']);
  const productId=text(body.product_id,80), orderId=text(body.order_id,80), rating=Math.min(Math.max(parseInt(body.rating,10)||0,0),5);
  if(rating<1||rating>5) throw new HttpError(400,'Choose a rating from 1 to 5.');
  const {rows}=await db.query(
    `INSERT INTO market_reviews(product_id,order_id,buyer_id,rating,review_text)
     SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM market_orders o JOIN market_order_items i ON i.order_id=o.id
       WHERE o.id=$2 AND o.buyer_id=$3 AND o.payment_status='paid' AND i.product_id=$1 AND i.fulfillment_status='delivered')
     RETURNING id`,[productId,orderId,user.id,rating,text(body.review_text,1200)]
  );
  if(!rows.length) throw new HttpError(403,'Reviews are available after the item has been delivered.');
  return {ok:true};
}

async function sellerFulfill(db,req,body) {
  const user=await requireRole(req,db,['seller','admin','super_admin']);
  const seller=await getSellerByUser(db,user.id,true);
  const status=['processing','dispatched'].includes(body.status)?body.status:null;
  if(!status) throw new HttpError(400,'Sellers can mark an item processing or dispatched. The buyer confirms receipt.');
  const itemId=text(body.order_item_id,80);
  const {rows}=await db.query(
    `UPDATE market_order_items SET fulfillment_status=$3,tracking_number=$4,tracking_carrier=$5
     WHERE id=$1 AND seller_id=$2 AND fulfillment_status NOT IN ('delivered','cancelled')
       AND EXISTS(SELECT 1 FROM market_orders o WHERE o.id=market_order_items.order_id AND o.payment_status='paid')
     RETURNING order_id`,[itemId,seller.id,status,text(body.tracking_number,100),text(body.tracking_carrier,100)]
  );
  if(!rows.length) throw new HttpError(404,'Paid order item not found for this seller.');
  await db.query(`INSERT INTO market_delivery_events(order_item_id,status,note,carrier,tracking_number,actor_id)
    VALUES($1,$2,$3,$4,$5,$6)`,[itemId,status,status==='dispatched'?'Seller marked this item as dispatched.':'Seller started preparing this item.',text(body.tracking_carrier,100),text(body.tracking_number,100),user.id]);
  await db.query(
    `UPDATE market_orders o SET status=CASE
      WHEN NOT EXISTS(SELECT 1 FROM market_order_items i WHERE i.order_id=o.id AND i.fulfillment_status NOT IN ('delivered','cancelled')) THEN 'delivered'
      WHEN EXISTS(SELECT 1 FROM market_order_items i WHERE i.order_id=o.id AND i.fulfillment_status='dispatched') THEN 'partially_dispatched'
      ELSE 'processing' END,updated_at=now() WHERE o.id=$1`,[rows[0].order_id]
  );
  const buyer=await db.query(
    `SELECT o.buyer_id,o.order_number,oi.product_name FROM market_orders o
     JOIN market_order_items oi ON oi.order_id=o.id WHERE oi.id=$1`,[itemId]
  );
  if(buyer.rows[0]) await createNotification(db,buyer.rows[0].buyer_id,{
    type:status==='dispatched'?'order_dispatched':'order_processing',
    title:status==='dispatched'?'Your order has been dispatched':'Your order is being prepared',
    message:status==='dispatched'
      ? `${buyer.rows[0].product_name} from order ${buyer.rows[0].order_number} has been dispatched.${text(body.tracking_number,100)?' Tracking: '+text(body.tracking_carrier,100)+' '+text(body.tracking_number,100):''}`
      : `${buyer.rows[0].product_name} from order ${buyer.rows[0].order_number} is now being prepared by the seller.`,
    target_tab:'orders',dedupe_key:`buyer-${status}:${itemId}`,metadata:{order_item_id:itemId,order_number:buyer.rows[0].order_number}
  });
  await audit(db,user.id,'ORDER_ITEM_FULFILMENT_UPDATED','order_item',itemId,{status});
  return {ok:true};
}

async function protectionHoldDays(db) {
  const settings=await getSettings(db);
  return Math.min(30,Math.max(1,Number(settings.seller_payout_hold_days)||7));
}

async function buyerConfirmDelivery(db,req,body) {
  const user=await requireRole(req,db,['buyer','seller','admin','super_admin']);
  const itemId=text(body.order_item_id,80);
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const {rows}=await client.query(
      `SELECT oi.id,oi.order_id,oi.product_type,oi.fulfillment_status,o.buyer_id,o.payment_status
       FROM market_order_items oi JOIN market_orders o ON o.id=oi.order_id
       WHERE oi.id=$1 FOR UPDATE OF oi,o`,[itemId]
    );
    const item=rows[0];
    if(!item) throw new HttpError(404,'Order item not found.');
    if(item.buyer_id!==user.id && !['admin','super_admin'].includes(user.role)) throw new HttpError(403,'This order does not belong to your account.');
    if(item.payment_status!=='paid') throw new HttpError(409,'Only a paid order can be confirmed.');
    if(item.product_type!=='physical') throw new HttpError(400,'Digital orders do not need delivery confirmation.');
    if(!['dispatched','delivered'].includes(item.fulfillment_status)) throw new HttpError(409,'The seller must mark the item as dispatched before you can confirm receipt.');
    const active=await client.query("SELECT id FROM market_disputes WHERE order_item_id=$1 AND status IN ('open','under_review')",[itemId]);
    if(active.rows.length) throw new HttpError(409,'This item has an open dispute. Resolve it before confirming receipt.');
    const holdDays=await protectionHoldDays(client);
    await client.query(
      "UPDATE market_order_items SET fulfillment_status='delivered',delivered_at=COALESCE(delivered_at,now()),buyer_confirmed_at=now() WHERE id=$1",
      [itemId]
    );
    await client.query(`INSERT INTO market_delivery_events(order_item_id,status,note,actor_id) VALUES($1,'delivered','Buyer confirmed receipt of this item.',$2)`,[itemId,user.id]);
    await client.query(
      `UPDATE market_payouts SET eligible_at=now()+($2::text||' days')::interval,
       hold_reason=$3, status=CASE WHEN status='held' THEN 'held' ELSE 'pending' END
       WHERE order_item_id=$1 AND status NOT IN ('paid','reversed')`,
      [itemId,holdDays,'Buyer confirmed receipt — protection period active']
    );
    await client.query(
      `UPDATE market_orders o SET status=CASE
       WHEN NOT EXISTS(SELECT 1 FROM market_order_items i WHERE i.order_id=o.id AND i.fulfillment_status NOT IN ('delivered','cancelled')) THEN 'delivered'
       WHEN EXISTS(SELECT 1 FROM market_order_items i WHERE i.order_id=o.id AND i.fulfillment_status='dispatched') THEN 'partially_dispatched'
       ELSE 'processing' END,updated_at=now() WHERE o.id=$1`,[item.order_id]
    );
    await client.query('COMMIT');
    const sellerOwner=await db.query(
      `SELECT s.user_id,oi.product_name,o.order_number FROM market_order_items oi
       JOIN market_sellers s ON s.id=oi.seller_id JOIN market_orders o ON o.id=oi.order_id WHERE oi.id=$1`,[itemId]
    );
    if(sellerOwner.rows[0]) await createNotification(db,sellerOwner.rows[0].user_id,{
      type:'buyer_confirmed_delivery',title:'Buyer confirmed receipt',
      message:`The buyer confirmed receipt of ${sellerOwner.rows[0].product_name} in order ${sellerOwner.rows[0].order_number}. The protection period is now active.`,
      target_tab:'orders',dedupe_key:`seller-buyer-confirmed:${itemId}`,metadata:{order_item_id:itemId,order_number:sellerOwner.rows[0].order_number}
    });
    await audit(db,user.id,'BUYER_CONFIRMED_DELIVERY','order_item',itemId,{protection_hold_days:holdDays});
    return {ok:true,eligible_in_days:holdDays};
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function buyerOpenDispute(db,req,body) {
  const user=await requireRole(req,db,['buyer','seller','admin','super_admin']);
  const itemId=text(body.order_item_id,80);
  const allowed=['item_not_received','damaged','not_as_described','wrong_item','digital_access','other'];
  const reason=allowed.includes(body.reason)?body.reason:null;
  const details=text(body.details,2000);
  if(!reason || details.length<20) throw new HttpError(400,'Choose a reason and describe the issue in at least 20 characters.');
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const {rows}=await client.query(
      `SELECT oi.id,oi.order_id,oi.seller_id,oi.product_name,o.buyer_id,o.order_number,o.payment_status
       FROM market_order_items oi JOIN market_orders o ON o.id=oi.order_id
       WHERE oi.id=$1 FOR UPDATE OF oi,o`,[itemId]
    );
    const item=rows[0];
    if(!item) throw new HttpError(404,'Order item not found.');
    if(item.buyer_id!==user.id && !['admin','super_admin'].includes(user.role)) throw new HttpError(403,'This order does not belong to your account.');
    if(item.payment_status!=='paid') throw new HttpError(409,'A dispute can only be opened for a paid order.');
    const existing=await client.query('SELECT id FROM market_disputes WHERE order_item_id=$1',[itemId]);
    if(existing.rows.length) throw new HttpError(409,'A case has already been opened for this item. Use the existing case or contact support.');
    const created=await client.query(
      `INSERT INTO market_disputes(order_item_id,order_id,buyer_id,seller_id,reason,details)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [item.id,item.order_id,item.buyer_id,item.seller_id,reason,details]
    );
    await client.query(
      "UPDATE market_payouts SET status=CASE WHEN status='paid' THEN 'paid' ELSE 'held' END,hold_reason='Buyer dispute open — payout release blocked' WHERE order_item_id=$1 AND status<>'reversed'",
      [itemId]
    );
    const sellerOwner=await client.query('SELECT user_id FROM market_sellers WHERE id=$1',[item.seller_id]);
    if(sellerOwner.rows[0]) await createNotification(client,sellerOwner.rows[0].user_id,{
      type:'buyer_dispute',title:'A buyer reported an order problem',
      message:`A buyer opened a case about ${item.product_name} in order ${item.order_number}. Your unpaid settlement is on hold while the case is reviewed.`,
      target_tab:'disputes',dedupe_key:`seller-dispute-opened:${created.rows[0].id}`,metadata:{dispute_id:created.rows[0].id,order_id:item.order_id,order_item_id:itemId}
    });
    await client.query('COMMIT');
    await audit(db,user.id,'BUYER_OPENED_DISPUTE','dispute',created.rows[0].id,{reason});
    return {dispute_id:created.rows[0].id,status:'open'};
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function sellerRespondDispute(db,req,body) {
  const user=await requireRole(req,db,['seller','admin','super_admin']);
  const seller=await getSellerByUser(db,user.id,true);
  const id=text(body.dispute_id,80), response=text(body.response,2000);
  if(response.length<10) throw new HttpError(400,'Please provide a response of at least 10 characters.');
  const {rows}=await db.query(
    `UPDATE market_disputes SET seller_response=$3,status='under_review',updated_at=now()
     WHERE id=$1 AND seller_id=$2 AND status IN ('open','under_review') RETURNING id`,
    [id,seller.id,response]
  );
  if(!rows.length) throw new HttpError(404,'Open dispute not found for this store.');
  const dispute=await db.query(
    `SELECT d.buyer_id,o.order_number,oi.product_name FROM market_disputes d
     JOIN market_orders o ON o.id=d.order_id JOIN market_order_items oi ON oi.id=d.order_item_id WHERE d.id=$1`,[id]
  );
  if(dispute.rows[0]) await createNotification(db,dispute.rows[0].buyer_id,{
    type:'seller_dispute_response',title:'The seller responded to your case',
    message:`The seller has responded to your report about ${dispute.rows[0].product_name} in order ${dispute.rows[0].order_number}. Marketplace administration will review the case.`,
    target_tab:'orders',dedupe_key:`buyer-dispute-response:${id}`,metadata:{dispute_id:id,order_number:dispute.rows[0].order_number}
  });
  await audit(db,user.id,'SELLER_RESPONDED_TO_DISPUTE','dispute',id);
  return {ok:true,status:'under_review'};
}

async function adminConfirmDelivery(db,req,body) {
  const user=await requireRole(req,db,['admin','super_admin']);
  const itemId=text(body.order_item_id,80), evidence=text(body.evidence,500);
  if(evidence.length<5) throw new HttpError(400,'Record the delivery evidence or tracking confirmation before continuing.');
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const {rows}=await client.query(
      `SELECT oi.id,oi.order_id,oi.product_type,oi.fulfillment_status,oi.product_name,o.payment_status,o.buyer_id,o.order_number,s.user_id AS seller_user_id
       FROM market_order_items oi JOIN market_orders o ON o.id=oi.order_id
       JOIN market_sellers s ON s.id=oi.seller_id
       WHERE oi.id=$1 FOR UPDATE OF oi,o`,[itemId]
    );
    const item=rows[0];
    if(!item) throw new HttpError(404,'Order item not found.');
    if(item.payment_status!=='paid' || item.product_type!=='physical') throw new HttpError(409,'Only paid physical items can be confirmed as delivered here.');
    if(['delivered','cancelled'].includes(item.fulfillment_status)) throw new HttpError(409,'This item is already delivered or cancelled.');
    const active=await client.query("SELECT id FROM market_disputes WHERE order_item_id=$1 AND status IN ('open','under_review')",[itemId]);
    if(active.rows.length) throw new HttpError(409,'Resolve the open buyer dispute before confirming delivery.');
    const holdDays=await protectionHoldDays(client);
    await client.query(
      "UPDATE market_order_items SET fulfillment_status='delivered',delivered_at=now() WHERE id=$1",
      [itemId]
    );
    await client.query(`INSERT INTO market_delivery_events(order_item_id,status,note,actor_id) VALUES($1,'delivered','Delivery marked as verified by marketplace administration.',$2)`,[itemId,user.id]);
    await client.query(
      `UPDATE market_payouts SET eligible_at=now()+($2::text||' days')::interval,
       hold_reason=$3,status=CASE WHEN status='held' THEN 'held' ELSE 'pending' END
       WHERE order_item_id=$1 AND status NOT IN ('paid','reversed')`,
      [itemId,holdDays,'Delivery verified by marketplace administration — protection period active']
    );
    await client.query(
      `UPDATE market_orders o SET status=CASE
       WHEN NOT EXISTS(SELECT 1 FROM market_order_items i WHERE i.order_id=o.id AND i.fulfillment_status NOT IN ('delivered','cancelled')) THEN 'delivered'
       WHEN EXISTS(SELECT 1 FROM market_order_items i WHERE i.order_id=o.id AND i.fulfillment_status='dispatched') THEN 'partially_dispatched'
       ELSE 'processing' END,updated_at=now() WHERE o.id=$1`,[item.order_id]
    );
    await createNotification(client,item.buyer_id,{
      type:'delivery_verified',title:'Delivery evidence verified',
      message:`ETHAN MARKET administration verified delivery for ${item.product_name} in order ${item.order_number}. You can contact support or open a case if you believe this is incorrect.`,
      target_tab:'orders',dedupe_key:`buyer-admin-delivery-verified:${itemId}`,metadata:{order_item_id:itemId,order_number:item.order_number}
    });
    await createNotification(client,item.seller_user_id,{
      type:'delivery_admin_verified',title:'Delivery verified by marketplace administration',
      message:`Delivery of ${item.product_name} in order ${item.order_number} was independently verified. The seller protection period is now active.`,
      target_tab:'orders',dedupe_key:`seller-admin-delivery-verified:${itemId}`,metadata:{order_item_id:itemId,order_number:item.order_number}
    });
    await client.query('COMMIT');
    await audit(db,user.id,'ADMIN_CONFIRMED_DELIVERY','order_item',itemId,{evidence,protection_hold_days:holdDays});
    return {ok:true,eligible_in_days:holdDays};
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function adminResolveDispute(db,req,body) {
  const user=await requireRole(req,db,['admin','super_admin']);
  const id=text(body.dispute_id,80), outcome=body.outcome;
  const notes=text(body.notes,2000), reference=text(body.refund_reference,140);
  if(!['seller','buyer'].includes(outcome) || notes.length<10) throw new HttpError(400,'Choose an outcome and add resolution notes.');
  if(outcome==='buyer' && reference.length<3) throw new HttpError(400,'Complete the refund through your payment provider first, then enter its refund reference.');
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    const {rows}=await client.query(
      `SELECT d.id,d.order_item_id,d.buyer_id,d.seller_id,d.order_id,o.order_number,oi.product_name,su.id AS seller_user_id
       FROM market_disputes d JOIN market_orders o ON o.id=d.order_id
       JOIN market_order_items oi ON oi.id=d.order_item_id
       JOIN market_sellers s ON s.id=d.seller_id JOIN market_users su ON su.id=s.user_id
       WHERE d.id=$1 AND d.status IN ('open','under_review') FOR UPDATE OF d`,[id]
    );
    if(!rows.length) throw new HttpError(404,'Open dispute not found.');
    const status=outcome==='seller'?'resolved_seller':'resolved_buyer';
    await client.query(
      `UPDATE market_disputes SET status=$2,resolution_notes=$3,resolution_reference=$4,resolved_at=now(),resolved_by=$5,updated_at=now() WHERE id=$1`,
      [id,status,notes,reference,user.id]
    );
    if(outcome==='seller') {
      await client.query(
        "UPDATE market_payouts SET status='pending',eligible_at=COALESCE(eligible_at,now()),hold_reason='Dispute resolved in seller favour — administrator approval required' WHERE order_item_id=$1 AND status NOT IN ('paid','reversed')",
        [rows[0].order_item_id]
      );
    } else {
      await client.query(
        "UPDATE market_payouts SET status='reversed',hold_reason='Dispute resolved in buyer favour — refund reference recorded' WHERE order_item_id=$1 AND status<>'paid'",
        [rows[0].order_item_id]
      );
      await client.query(
        "UPDATE market_affiliate_conversions SET status='void' WHERE order_id=$1 AND status IN ('pending','approved')",
        [rows[0].order_id]
      );
    }
    const resolutionText=outcome==='seller'
      ? `The case for ${rows[0].product_name} in order ${rows[0].order_number} was resolved in the seller's favour. Seller settlement is eligible for administrator approval.`
      : `The case for ${rows[0].product_name} in order ${rows[0].order_number} was resolved in your favour. The refund reference has been recorded.`;
    await createNotification(client,rows[0].buyer_id,{
      type:'dispute_resolved',title:'Your buyer protection case was resolved',
      message:resolutionText,target_tab:'orders',dedupe_key:`buyer-dispute-resolved:${id}`,metadata:{dispute_id:id,outcome}
    });
    await createNotification(client,rows[0].seller_user_id,{
      type:'dispute_resolved',title:'Buyer protection case resolved',
      message:resolutionText,target_tab:'disputes',dedupe_key:`seller-dispute-resolved:${id}`,metadata:{dispute_id:id,outcome}
    });
    await client.query('COMMIT');
    await audit(db,user.id,'DISPUTE_RESOLVED','dispute',id,{outcome,refund_reference:outcome==='buyer'?reference:''});
    return {ok:true,status};
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function adminOverview(db,req) {
  const user=await requireRole(req,db,['admin','super_admin']);
  const [orders,products,sellers,payouts,recent]=await Promise.all([
    db.query(`SELECT count(*) AS count,COALESCE(sum(total_kobo) FILTER(WHERE payment_status='paid'),0) AS gmv,
      count(*) FILTER(WHERE payment_status='paid') AS paid_orders,count(*) FILTER(WHERE payment_status='pending') AS awaiting_payment FROM market_orders`),
    db.query("SELECT count(*) AS total,count(*) FILTER(WHERE status='active') AS active,count(*) FILTER(WHERE status='pending') AS pending FROM market_products"),
    db.query("SELECT count(*) AS total,count(*) FILTER(WHERE seller_status='approved') AS approved,count(*) FILTER(WHERE seller_status='pending') AS pending FROM market_sellers"),
    db.query("SELECT count(*) AS count,COALESCE(sum(net_kobo) FILTER(WHERE status IN ('pending','approved','held')),0) AS outstanding FROM market_payouts"),
    db.query(`SELECT o.id,o.order_number,o.buyer_email,o.total_kobo,o.payment_status,o.status,o.created_at FROM market_orders o ORDER BY o.created_at DESC LIMIT 8`)
  ]);
  return {
    orders:orders.rows[0],products:products.rows[0],sellers:sellers.rows[0],payouts:payouts.rows[0],recent:recent.rows,
    integrations:{monnify_configured:monnifyConfigured(),payment_environment:monnifyBaseUrl()==='https://api.monnify.com'?'Live':'Sandbox',media_uploads_configured:!!process.env.BLOB_READ_WRITE_TOKEN,payout_encryption_configured:!!fieldKey()}
  };
}

async function adminList(db,req,kind) {
  await requireRole(req,db,['admin','super_admin']);
  if(kind==='sellers') {
    const {rows}=await db.query(`SELECT s.*,u.full_name,u.email,u.phone FROM market_sellers s JOIN market_users u ON u.id=s.user_id ORDER BY CASE s.seller_status WHEN 'pending' THEN 0 ELSE 1 END,s.created_at DESC LIMIT 250`);
    return {sellers:rows.map(s=>({...sellerPublic(s),user_name:s.full_name,email:s.email,user_phone:s.phone}))};
  }
  if(kind==='products') {
    const {rows}=await db.query(`SELECT p.*,s.store_name,c.name AS category_name FROM market_products p JOIN market_sellers s ON s.id=p.seller_id LEFT JOIN market_categories c ON c.id=p.category_id ORDER BY CASE p.status WHEN 'pending' THEN 0 ELSE 1 END,p.created_at DESC LIMIT 250`);
    const variants=await db.query(`SELECT id,product_id,label,sku,price_kobo,stock_qty FROM market_product_variants WHERE is_active=true AND product_id=ANY($1::uuid[]) ORDER BY label`,[rows.map(p=>p.id)]);
    const byProduct=new Map();
    for(const variant of variants.rows){if(!byProduct.has(variant.product_id))byProduct.set(variant.product_id,[]);byProduct.get(variant.product_id).push(variant);}
    for(const product of rows)product.variants=byProduct.get(product.id)||[];
    return {products:rows};
  }
  if(kind==='orders') {
    const {rows}=await db.query(`SELECT o.*,COALESCE(json_agg(json_build_object('id',i.id,'product_name',i.product_name,'variant_label',i.variant_label,'variant_sku',i.variant_sku,'product_type',i.product_type,'quantity',i.quantity,'seller_id',i.seller_id,'fulfillment_status',i.fulfillment_status,'tracking_number',i.tracking_number,'tracking_carrier',i.tracking_carrier)) FILTER(WHERE i.id IS NOT NULL),'[]'::json) AS items FROM market_orders o LEFT JOIN market_order_items i ON i.order_id=o.id GROUP BY o.id ORDER BY o.created_at DESC LIMIT 250`);
    return {orders:rows};
  }
  if(kind==='payouts') {
    const {rows}=await db.query(`SELECT p.*,s.store_name,u.full_name,u.email,o.order_number,s.bank_name,s.bank_code,s.account_number,s.account_name
      FROM market_payouts p JOIN market_sellers s ON s.id=p.seller_id JOIN market_users u ON u.id=s.user_id
      JOIN market_orders o ON o.id=p.order_id ORDER BY CASE p.status WHEN 'held' THEN 0 WHEN 'pending' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END,p.created_at DESC LIMIT 500`);
    return {payouts:rows.map(p=>({...p,bank_code:decryptField(p.bank_code),account_number:decryptField(p.account_number)}))};
  }
  if(kind==='disputes') {
    const {rows}=await db.query(`SELECT d.*,o.order_number,oi.product_name,oi.quantity,oi.product_type,
      b.full_name AS buyer_name,b.email AS buyer_email,s.store_name,u.full_name AS seller_name,u.email AS seller_email
      FROM market_disputes d JOIN market_orders o ON o.id=d.order_id
      JOIN market_order_items oi ON oi.id=d.order_item_id
      JOIN market_users b ON b.id=d.buyer_id JOIN market_sellers s ON s.id=d.seller_id
      JOIN market_users u ON u.id=s.user_id ORDER BY CASE d.status WHEN 'open' THEN 0 WHEN 'under_review' THEN 1 ELSE 2 END,d.opened_at DESC LIMIT 500`);
    return {disputes:rows};
  }
  if(kind==='growth') return adminGrowthOverview(db,req);
  if(kind==='settings') return {settings:await getSettings(db)};
  throw new HttpError(400,'Unknown administration list.');
}

async function adminAction(db,req,body) {
  const user=await requireRole(req,db,['admin','super_admin']);
  const action=body.action;
  const id=text(body.id,80);
  if(action==='admin.growth-campaign-save') {
    const name=text(body.name,120),slug=text(body.slug,80).toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-|-$/g,'');
    if(name.length<3||slug.length<3) throw new HttpError(400,'Enter a campaign name and a valid URL slug.');
    const status=['active','paused','completed'].includes(body.status)?body.status:'active';
    const budget=money(body.budget_kobo);
    if(body.id) {
      const updated=await db.query(
        `UPDATE market_growth_campaigns SET name=$2,slug=$3,source=$4,medium=$5,budget_kobo=$6,status=$7,updated_at=now()
         WHERE id=$1 RETURNING id`,[text(body.id,80),name,slug,text(body.source,80),text(body.medium,80),budget,status]
      );
      if(!updated.rows.length) throw new HttpError(404,'Campaign not found.');
    } else {
      try {
        await db.query(
          `INSERT INTO market_growth_campaigns(name,slug,source,medium,budget_kobo,status,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,[name,slug,text(body.source,80),text(body.medium,80),budget,status,user.id]
        );
      } catch(error) { if(error.code==='23505') throw new HttpError(409,'That campaign slug already exists. Choose another slug.'); throw error; }
    }
    await audit(db,user.id,'GROWTH_CAMPAIGN_SAVED','campaign',slug,{status});
    return {ok:true};
  }
  if(action==='admin.growth-promo-save') {
    const code=text(body.code,40).toUpperCase().replace(/[^A-Z0-9-]/g,'');
    const bps=Math.min(10000,Math.max(1,parseInt(body.discount_bps,10)||0));
    const maxDiscount=money(body.max_discount_kobo),minimum=money(body.min_subtotal_kobo);
    const maxUses=body.max_redemptions?Math.min(100000,Math.max(1,parseInt(body.max_redemptions,10)||1)):null;
    if(code.length<4) throw new HttpError(400,'Promo codes must contain at least four letters or numbers.');
    try {
      await db.query(
        `INSERT INTO market_promo_codes(code,discount_bps,max_discount_kobo,min_subtotal_kobo,max_redemptions,active,created_by)
         VALUES($1,$2,$3,$4,$5,true,$6)`,[code,bps,maxDiscount,minimum,maxUses,user.id]
      );
    } catch(error) { if(error.code==='23505') throw new HttpError(409,'That promo code already exists. Choose another code.'); throw error; }
    await audit(db,user.id,'GROWTH_PROMO_CREATED','promo',code,{discount_bps:bps,max_redemptions:maxUses});
    return {ok:true,code};
  }
  if(action==='admin.growth-promo-status') {
    const active=body.active===true;
    const result=await db.query('UPDATE market_promo_codes SET active=$2 WHERE id=$1 RETURNING id',[text(body.id,80),active]);
    if(!result.rows.length) throw new HttpError(404,'Promo code not found.');
    return {ok:true};
  }
  if(action==='admin.growth-campaign-status') {
    const status=['active','paused','completed'].includes(body.status)?body.status:null;
    if(!status) throw new HttpError(400,'Invalid campaign status.');
    const result=await db.query('UPDATE market_growth_campaigns SET status=$2,updated_at=now() WHERE id=$1 RETURNING id',[text(body.id,80),status]);
    if(!result.rows.length) throw new HttpError(404,'Campaign not found.');
    return {ok:true};
  }
  if(action==='admin.affiliate-status') {
    const status=['approved','paused','none'].includes(body.status)?body.status:null;
    if(!status) throw new HttpError(400,'Invalid affiliate status.');
    const bps=Math.min(5000,Math.max(0,parseInt(body.commission_share_bps,10)||0));
    const result=await db.query(
      `UPDATE market_growth_profiles SET affiliate_status=$2,affiliate_commission_bps=$3 WHERE user_id=$1 RETURNING user_id`,
      [text(body.user_id,80),status,bps]
    );
    if(!result.rows.length) throw new HttpError(404,'Affiliate profile not found.');
    await createNotification(db,result.rows[0].user_id,{
      type:'affiliate_status',title:'Your affiliate application was updated',
      message:status==='approved'?'You have been approved for the ETHAN MARKET affiliate programme. Share your referral link to bring customers.':'Your affiliate programme status is now '+status+'.',
      target_tab:'growth',dedupe_key:`affiliate-status-${status}:${result.rows[0].user_id}:${Date.now()}`
    });
    await audit(db,user.id,'AFFILIATE_STATUS_CHANGED','affiliate',result.rows[0].user_id,{status,commission_share_bps:bps});
    return {ok:true};
  }
  if(action==='admin.affiliate-conversion') {
    const status=['approved','paid','void'].includes(body.status)?body.status:null;
    if(!status) throw new HttpError(400,'Invalid affiliate conversion status.');
    if(status==='paid'&&!text(body.payout_reference,140)) throw new HttpError(400,'Record the cleared bank transfer reference first.');
    const expected=status==='paid'?'approved':'pending';
    const result=await db.query(
      `UPDATE market_affiliate_conversions SET status=$2,payout_reference=CASE WHEN $2='paid' THEN $3 ELSE payout_reference END,
       paid_at=CASE WHEN $2='paid' THEN now() ELSE paid_at END
       WHERE id=$1 AND status=$4 RETURNING affiliate_user_id,commission_kobo,order_id`,
      [text(body.id,80),status,text(body.payout_reference,140),expected]
    );
    if(!result.rows.length) throw new HttpError(409,'Affiliate conversion cannot be updated.');
    await createNotification(db,result.rows[0].affiliate_user_id,{
      type:'affiliate_reward',title:status==='paid'?'Affiliate reward paid':'Affiliate conversion updated',
      message:status==='paid'?`Your affiliate reward has been recorded as paid. Reference: ${text(body.payout_reference,140)}.`:`Your affiliate conversion status is now ${status.replaceAll('_',' ')}.`,
      target_tab:'growth',dedupe_key:`affiliate-conversion-${status}:${text(body.id,80)}`
    });
    return {ok:true};
  }
  if(action==='admin.seller-status') {
    const status=['approved','rejected','suspended'].includes(body.status)?body.status:null;
    if(!status) throw new HttpError(400,'Invalid seller status.');
    const {rows}=await db.query('UPDATE market_sellers SET seller_status=$2,updated_at=now() WHERE id=$1 RETURNING user_id,store_name',[id,status]);
    if(!rows.length) throw new HttpError(404,'Seller not found.');
    if(status==='approved') {
      await db.query("UPDATE market_users SET role='seller',updated_at=now() WHERE id=$1 AND role='buyer'",[rows[0].user_id]);
      await db.query(
        `UPDATE market_growth_attributions SET status=CASE WHEN first_order_at IS NOT NULL THEN status ELSE 'seller_approved' END,
         seller_approved_at=COALESCE(seller_approved_at,now()) WHERE referred_user_id=$1`,[rows[0].user_id]
      );
    }
    if(status==='suspended') await db.query("UPDATE market_users SET role='buyer',updated_at=now() WHERE id=$1 AND role='seller'",[rows[0].user_id]);
    await createNotification(db,rows[0].user_id,{
      type:'seller_application_status',title:status==='approved'?'Your seller application was approved':'Your seller application was updated',
      message:status==='approved'?`Your store ${rows[0].store_name} has been approved. You can now list products and manage orders.`:`Your store ${rows[0].store_name} status is now ${status}. Please sign in to review your seller account.`,
      target_tab:'overview',dedupe_key:`seller-status-${status}:${id}`,metadata:{seller_id:id,status}
    });
    await audit(db,user.id,'SELLER_STATUS_CHANGED','seller',id,{status}); return {ok:true};
  }
  if(action==='admin.product-status') {
    const status=['active','rejected','archived'].includes(body.status)?body.status:null;
    if(!status) throw new HttpError(400,'Invalid product status.');
    const {rows}=await db.query('UPDATE market_products SET status=$2,featured=$3,updated_at=now() WHERE id=$1 RETURNING id,seller_id,name',[id,status,status==='active'&&body.featured===true]);
    if(!rows.length) throw new HttpError(404,'Product not found.');
    const owner=await db.query('SELECT user_id FROM market_sellers WHERE id=$1',[rows[0].seller_id]);
    if(owner.rows[0]) await createNotification(db,owner.rows[0].user_id,{
      type:'product_review_status',title:status==='active'?'Your product is now live':'Your product listing was reviewed',
      message:`"${rows[0].name}" is now marked ${status} by ETHAN MARKET administration.`,
      target_tab:'products',dedupe_key:`product-review-${status}:${id}`,metadata:{product_id:id,status}
    });
    await audit(db,user.id,'PRODUCT_STATUS_CHANGED','product',id,{status}); return {ok:true};
  }
  if(action==='admin.payout-status') {
    const status=['approved','held','paid'].includes(body.status)?body.status:null;
    if(!status) throw new HttpError(400,'Invalid payout status.');
    if(status==='paid'&&!text(body.payout_reference,140)) throw new HttpError(400,'A bank transfer reference is required to record a completed payout.');
    let rows;
    if(status==='approved') {
      const result=await db.query(
        `UPDATE market_payouts p SET status='approved',hold_reason='Approved for manual bank transfer'
         WHERE p.id=$1 AND p.status='pending' AND p.eligible_at IS NOT NULL AND p.eligible_at<=now()
         AND NOT EXISTS(SELECT 1 FROM market_disputes d WHERE d.order_item_id=p.order_item_id AND d.status IN ('open','under_review'))
         RETURNING p.id`,[id]
      ); rows=result.rows;
    } else if(status==='held') {
      const result=await db.query("UPDATE market_payouts SET status='held',hold_reason='Administrator hold' WHERE id=$1 AND status IN ('pending','approved') RETURNING id",[id]);
      rows=result.rows;
    } else {
      const result=await db.query(
        `UPDATE market_payouts SET status='paid',payout_reference=$2,paid_at=now(),hold_reason=''
         WHERE id=$1 AND status='approved' AND NOT EXISTS(SELECT 1 FROM market_disputes d WHERE d.order_item_id=market_payouts.order_item_id AND d.status IN ('open','under_review'))
         RETURNING id`,[id,text(body.payout_reference,140)]
      ); rows=result.rows;
    }
    if(!rows.length) throw new HttpError(409,'Payout cannot be changed. Check its protection period, dispute status and current payout state.');
    const payoutOwner=await db.query(
      `SELECT s.user_id,o.order_number,p.net_kobo,s.store_name FROM market_payouts p
       JOIN market_sellers s ON s.id=p.seller_id JOIN market_orders o ON o.id=p.order_id WHERE p.id=$1`,[id]
    );
    if(payoutOwner.rows[0]) await createNotification(db,payoutOwner.rows[0].user_id,{
      type:'payout_status',title:status==='paid'?'Seller payout recorded':status==='approved'?'Seller payout approved':'Seller payout placed on hold',
      message:status==='paid'
        ? `Your payout for order ${payoutOwner.rows[0].order_number} has been marked paid. Reference: ${text(body.payout_reference,140)}.`
        : status==='approved'
          ? `Your settlement for order ${payoutOwner.rows[0].order_number} has been approved for manual bank transfer.`
          : `Your settlement for order ${payoutOwner.rows[0].order_number} has been placed on hold by marketplace administration.`,
      target_tab:'payouts',dedupe_key:`seller-payout-${status}:${id}`,metadata:{payout_id:id,status}
    });
    await audit(db,user.id,'PAYOUT_STATUS_CHANGED','payout',id,{status}); return {ok:true};
  }
  if(action==='admin.confirm-delivery') return adminConfirmDelivery(db,req,body);
  if(action==='admin.dispute-resolve') return adminResolveDispute(db,req,body);
  if(action==='admin.settings') {
    const commission=Math.min(Math.max(parseInt(body.commission_bps,10)||0,0),5000);
    const shipping=money(body.physical_shipping_kobo);
    const holdDays=Math.min(30,Math.max(1,parseInt(body.seller_payout_hold_days,10)||7));
    await db.query("INSERT INTO market_settings(key,value) VALUES('commission_bps',$1::jsonb),('physical_shipping_kobo',$2::jsonb),('seller_payout_hold_days',$3::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[JSON.stringify(commission),JSON.stringify(shipping),JSON.stringify(holdDays)]);
    await db.query('UPDATE market_sellers SET commission_bps=$1,updated_at=now()', [commission]);
    await audit(db,user.id,'MARKET_SETTINGS_UPDATED','settings','market'); return {settings:await getSettings(db)};
  }
  if(action==='admin.order-status') {
    const status=['processing','dispatched','delivered','cancelled'].includes(body.status)?body.status:null;
    if(!status) throw new HttpError(400,'Invalid order status.');
    const {rows}=await db.query('UPDATE market_orders SET status=$2,updated_at=now() WHERE id=$1 RETURNING id,buyer_id,order_number',[id,status]);
    if(!rows.length) throw new HttpError(404,'Order not found.');
    await createNotification(db,rows[0].buyer_id,{
      type:'order_status',title:'Your order status changed',
      message:`Order ${rows[0].order_number} is now ${status.replaceAll('_',' ')}.`,
      target_tab:'orders',dedupe_key:`buyer-admin-order-status-${status}:${id}`,metadata:{order_id:id,status}
    });
    await audit(db,user.id,'ORDER_STATUS_CHANGED','order',id,{status}); return {ok:true};
  }
  throw new HttpError(400,'Unsupported administration action.');
}

async function storeDetails(db, slug) {
  const {rows}=await db.query(`SELECT s.id,s.store_name,s.slug,s.description,s.city,s.state,s.created_at,u.full_name
    FROM market_sellers s JOIN market_users u ON u.id=s.user_id WHERE s.slug=$1 AND s.seller_status='approved' LIMIT 1`,[text(slug,100)]);
  if(!rows.length) throw new HttpError(404,'Store not found.');
  const products=await listProducts(db,{limit:60});
  return {store:rows[0],products:products.filter(p=>p.seller_id===rows[0].id)};
}

async function handle(db,req,res,body) {
  const action=text(body.action,80);
  if(action==='health') return {status:'ok',service:'ETHAN MARKET',database:'connected',payments:monnifyConfigured(),payment_provider:'Monnify'};
  if(action==='market.config') { const settings=await getSettings(db); return { marketplace_name:'ETHAN MARKET', shipping_kobo:Number(settings.physical_shipping_kobo ?? 200000), commission_bps:Number(settings.commission_bps ?? 1000), seller_payout_hold_days:Math.min(30,Math.max(1,Number(settings.seller_payout_hold_days)||7)), payments_enabled:monnifyConfigured(), payment_provider:'Monnify', support_email:String(settings.support_email || 'ethandigitalacademy@gmail.com') }; }
  if(action==='auth.register') return authRegister(db,req,res,body);
  if(action==='auth.login') return authLogin(db,req,res,body);
  if(action==='auth.me') return authMe(db,req);
  if(action==='auth.logout') return signOut(db,req,res);
  if(action==='categories.list') return {categories:await publicCategories(db)};
  if(action==='products.list') return {products:await listProducts(db,body)};
  if(action==='products.detail') return {product:await productDetail(db,body.id || body.slug)};
  if(action==='store.detail') return storeDetails(db,body.slug);
  if(action==='seller.apply') return applySeller(db,req,body);
  if(action==='seller.dashboard') return sellerDashboard(db,req);
  if(action==='seller.profile') return saveSellerProfile(db,req,body);
  if(action==='seller.product.save') return saveProduct(db,req,body);
  if(action==='seller.inventory.update') return updateSellerInventory(db,req,body);
  if(action==='seller.variant-stock.update') return updateSellerVariantInventory(db,req,body);
  if(action==='seller.products.bulk') return bulkSaveProducts(db,req,body);
  if(action==='seller.fulfill') return sellerFulfill(db,req,body);
  if(action==='questions.ask') return askProductQuestion(db,req,body);
  if(action==='questions.answer') return answerProductQuestion(db,req,body);
  if(action==='messages.open') return openMessageConversation(db,req,body);
  if(action==='messages.threads') return messageThreads(db,req);
  if(action==='messages.thread') return messageThread(db,req,body);
  if(action==='messages.send') return sendMessage(db,req,body);
  if(action==='buyer.orders') return buyerOrders(db,req);
  if(action==='buyer.confirm-delivery') return buyerConfirmDelivery(db,req,body);
  if(action==='buyer.open-dispute') return buyerOpenDispute(db,req,body);
  if(action==='seller.respond-dispute') return sellerRespondDispute(db,req,body);
  if(action==='notifications.list') return notificationsList(db,req);
  if(action==='notifications.mark-read') return notificationsMarkRead(db,req,body);
  if(action==='growth.dashboard') return growthDashboard(db,req);
  if(action==='growth.affiliate-apply') return applyAffiliate(db,req);
  if(action==='growth.track') return growthTrack(db,req,body);
  if(action==='growth.promo-preview') return growthPromoPreview(db,req,body);
  if(action==='wishlist.list') return wishlist(db,req);
  if(action==='wishlist.toggle') return toggleWishlist(db,req,body);
  if(action==='reviews.create') return addReview(db,req,body);
  if(action==='checkout.create') return checkout(db,req,body);
  if(action==='payment.verify') return verifyPayment(db,req,body);
  if(action==='admin.overview') return adminOverview(db,req);
  if(action==='admin.list') return adminList(db,req,body.kind);
  if(action.startsWith('admin.')) return adminAction(db,req,body);
  throw new HttpError(400,'Unknown marketplace action.');
}

module.exports = async function handler(req,res) {
  const pathname = (()=>{try{return new URL(req.url,'https://market.ethandigitalacademy.org').pathname}catch{return '/api/market'}})();
  if(req.method==='OPTIONS') { res.statusCode=204; res.setHeader('Allow','POST, GET, OPTIONS'); return res.end(); }
  if(req.method==='GET') {
    const url = new URL(req.url || '/api/market', 'https://market.ethandigitalacademy.org');
    if (url.searchParams.get('health') === '1') {
      try { await ensureSchema(); return send(res,200,{status:'ok',service:'ETHAN MARKET',database:'connected',payments:monnifyConfigured(),payment_provider:'Monnify',uploads:!!process.env.BLOB_READ_WRITE_TOKEN}); }
      catch(e) { console.error('ETHAN MARKET health check failed:',e.message); return send(res,503,{status:'unavailable',service:'ETHAN MARKET',database:'unavailable'}); }
    }
    return send(res,405,{error:'Method not allowed.'});
  }
  if(pathname.endsWith('/webhook')) {
    if(req.method!=='POST') return send(res,405,{error:'Method not allowed.'});
    try { await ensureSchema(); return await webhook(req,res,getPool()); }
    catch(e) { console.error('ETHAN MARKET webhook error:',e.message); return send(res,e.status||500,{error:e.status?e.message:'Webhook processing failed.'}); }
  }
  if(req.method!=='POST') return send(res,405,{error:'Method not allowed.'});
  try {
    safeOrigin(req);
    const body=await readBody(req);
    await ensureSchema();
    const result=await handle(getPool(),req,res,body);
    return send(res,200,{data:result});
  } catch(e) {
    const status=Number(e.status)||500;
    if(status>=500) console.error('ETHAN MARKET API error:',e.stack||e.message);
    return send(res,status,{error:status>=500?'The marketplace service is temporarily unavailable.':e.message});
  }
};

module.exports.config = { api: { bodyParser: false } };
