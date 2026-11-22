'use strict';

const crypto = require('node:crypto');
const { Pool } = require('pg');
const { calculateCommissionKobo, calculateCheckoutBreakdown } = require('../lib/commercial');

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
    account_name text NOT NULL DEFAULT '', commission_bps int NOT NULL DEFAULT 500 CHECK (commission_bps BETWEEN 0 AND 5000),
    paystack_subaccount_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS market_products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_id uuid NOT NULL REFERENCES market_sellers(id),
    category_id uuid REFERENCES market_categories(id), name text NOT NULL, slug text NOT NULL,
    description text NOT NULL DEFAULT '', product_type text NOT NULL DEFAULT 'physical' CHECK (product_type IN ('physical','digital')),
    price_kobo bigint NOT NULL CHECK (price_kobo >= 100), compare_at_kobo bigint CHECK (compare_at_kobo IS NULL OR compare_at_kobo >= price_kobo),
    image_url text NOT NULL DEFAULT '', sku text NOT NULL DEFAULT '', stock_qty int NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
    digital_delivery_url text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'pending' CHECK (status IN ('draft','pending','active','rejected','archived')),
    featured boolean NOT NULL DEFAULT false, views int NOT NULL DEFAULT 0, variants jsonb NOT NULL DEFAULT '[]'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(seller_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS market_products_public_idx ON market_products(status, category_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS market_products_seller_idx ON market_products(seller_id, status)`,
  `ALTER TABLE market_products ADD COLUMN IF NOT EXISTS variants jsonb NOT NULL DEFAULT '[]'::jsonb`,
  `CREATE TABLE IF NOT EXISTS market_schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS market_orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_number text NOT NULL UNIQUE,
    buyer_id uuid NOT NULL REFERENCES market_users(id), buyer_email text NOT NULL,
    recipient_name text NOT NULL, phone text NOT NULL, subtotal_kobo bigint NOT NULL, shipping_kobo bigint NOT NULL DEFAULT 0,
    total_kobo bigint NOT NULL, currency text NOT NULL DEFAULT 'NGN', payment_status text NOT NULL DEFAULT 'pending'
      CHECK (payment_status IN ('pending','paid','failed','refunded','reversed')),
    status text NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment','processing','partially_dispatched','dispatched','delivered','cancelled','refunded')),
    paystack_reference text UNIQUE, shipping_address jsonb NOT NULL DEFAULT '{}'::jsonb, buyer_note text NOT NULL DEFAULT '',
    payment_verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`,
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
    stock_deducted boolean NOT NULL DEFAULT false, variant_id text NOT NULL DEFAULT '', variant_label text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE market_order_items ADD COLUMN IF NOT EXISTS variant_id text NOT NULL DEFAULT ''`,
  `ALTER TABLE market_order_items ADD COLUMN IF NOT EXISTS variant_label text NOT NULL DEFAULT ''`,
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
  `CREATE TABLE IF NOT EXISTS market_delivery_zones (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
    state text NOT NULL DEFAULT '*', city text NOT NULL DEFAULT '*',
    fee_kobo bigint NOT NULL CHECK (fee_kobo >= 0), active boolean NOT NULL DEFAULT true,
    is_fallback boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS market_delivery_zones_match_uq ON market_delivery_zones(lower(state),lower(city))`,
  `ALTER TABLE market_payments ADD COLUMN IF NOT EXISTS gateway_fee_kobo bigint NOT NULL DEFAULT 0`,
  `ALTER TABLE market_payments ADD COLUMN IF NOT EXISTS gateway_fee_recorded_at timestamptz`,
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
    ('commission_bps','500'::jsonb),('physical_shipping_kobo','200000'::jsonb),('marketplace_name','"ETHAN MARKET"'::jsonb),
    ('support_email','"ethandigitalacademy@gmail.com"'::jsonb),('seller_payout_hold_days','7'::jsonb),
    ('payment_processing_bearer','"ethan"'::jsonb),('delivery_pricing_mode','"zone"'::jsonb)
    ON CONFLICT(key) DO NOTHING`,
  `INSERT INTO market_delivery_zones(name,state,city,fee_kobo,active,is_fallback)
    VALUES('Nationwide default','*','*',200000,true,true)
    ON CONFLICT(lower(state),lower(city)) DO NOTHING`
];

async function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const db = getPool();
    // Normal production requests should not replay all DDL on every cold start.
    // Check the complete marketplace table set first; only bootstrap when needed.
    const requiredTables = [
      'market_users','market_sessions','market_categories','market_sellers',
      'market_products','market_schema_migrations','market_orders','market_order_items','market_payments',
      'market_payouts','market_disputes','market_wishlists','market_reviews','market_settings',
      'market_audit_logs','market_rate_limits','market_notifications','market_growth_profiles','market_growth_attributions','market_growth_campaigns','market_promo_codes','market_promo_redemptions','market_affiliate_conversions','market_growth_events','market_delivery_zones'
    ];
    const countTables = async (executor) => {
      const result = await executor.query(
        "SELECT COUNT(*)::int AS count FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1::text[])",
        [requiredTables]
      );
      return Number(result.rows[0]?.count || 0);
    };
    if (await countTables(db) === requiredTables.length) return;

    // Serialize only a genuine schema bootstrap. Re-check after obtaining the
    // lock in case another cold-start instance completed it while we waited.
    const client = await db.connect();
    const lockKey = 781204501;
    let locked = false;
    try {
      await client.query('SELECT pg_advisory_lock($1)', [lockKey]);
      locked = true;
      if (await countTables(client) !== requiredTables.length) {
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

async function checkoutPreview(db,req,body){
 const user=await requireRole(req,db,['buyer','seller','admin','super_admin']);await rateLimit(db,'checkout-preview',user.id,30,15);
 const items=Array.isArray(body.items)?body.items:[];if(!items.length||items.length>30)throw new HttpError(400,'Your cart is empty or invalid.');
 const ids=[...new Set(items.map(x=>text(x.product_id,80)).filter(x=>/^[0-9a-f-]{36}$/i.test(x)))];if(!ids.length)throw new HttpError(400,'Your basket is not valid.');
 const {rows}=await db.query("SELECT p.id,p.price_kobo,p.product_type,p.stock_qty,p.variants,s.commission_bps FROM market_products p JOIN market_sellers s ON s.id=p.seller_id WHERE p.id=ANY($1::uuid[]) AND p.status='active' AND s.seller_status='approved'",[ids]);
 if(rows.length!==ids.length)throw new HttpError(409,'One or more products are no longer available.');
 let subtotal=0,physical=false,commission=0;
 for(const item of items){
  const p=rows.find(x=>x.id===item.product_id);if(!p)throw new HttpError(409,'A product is no longer available.');
  const quantity=Math.min(20,Math.max(1,parseInt(item.quantity,10)||1)),variants=Array.isArray(p.variants)?p.variants:[];
  let unitPrice=Number(p.price_kobo);
  if(variants.length){const v=variants.find(x=>x.id===item.variant_id&&x.active!==false);if(!v)throw new HttpError(409,'Choose an available variation for '+p.name+'.');unitPrice=Number(v.price_kobo);if(Number(v.stock_qty)<quantity)throw new HttpError(409,v.name+' has only '+v.stock_qty+' item(s) available.');}
  else if(item.variant_id)throw new HttpError(409,'This variation is no longer available.');
  const gross=unitPrice*quantity;subtotal+=gross;commission+=calculateCommissionKobo(gross,Number(p.commission_bps));if(p.product_type==='physical')physical=true;
 }
 const zone=physical?await resolveDeliveryZone(db,body.state||'',body.city||''):null,shipping=zone?zone.fee_kobo:0,code=text(body.code||body.promo_code,40).toUpperCase();
 const promo=code?await resolvePromo(db,user,code,subtotal,commission,false):null,discount=promo?promo.discount_kobo:0;
 const breakdown=calculateCheckoutBreakdown({subtotalKobo:subtotal,deliveryKobo:shipping,discountKobo:discount});
 return {subtotal_kobo:breakdown.subtotalKobo,shipping_kobo:breakdown.deliveryKobo,discount_kobo:breakdown.discountKobo,total_kobo:breakdown.totalKobo,delivery_zone_name:zone?.name||'Digital products',delivery_location_label:[text(body.city,80),text(body.state,80)].filter(Boolean).join(', '),payment_processing_fee_kobo:0,payment_processing_bearer:'ETHAN MARKET',promo_code:promo?.code||''};
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
  let subtotal=0,fee=0,physical=false;
  for(const product of rows) {
    const q=items.filter(x=>x.product_id===product.id).reduce((n,x)=>n+Math.min(20,Math.max(1,parseInt(x.quantity,10)||1)),0);
    subtotal+=Number(product.price_kobo)*q;
    fee+=calculateCommissionKobo(Number(product.price_kobo)*q,Number(product.commission_bps));
    if(product.product_type==='physical') physical=true;
  }
  const promo=await resolvePromo(db,user,text(body.code,40).toUpperCase(),subtotal,fee,false);
  const deliveryZone=physical?await resolveDeliveryZone(db,body.state,body.city):null;
  const shipping=deliveryZone?deliveryZone.fee_kobo:0;
  const breakdown=calculateCheckoutBreakdown({subtotalKobo:subtotal,deliveryKobo:shipping,discountKobo:promo.discount_kobo});
  return {code:promo.code,discount_kobo:promo.discount_kobo,subtotal_kobo:subtotal,shipping_kobo:shipping,
    delivery_zone_name:deliveryZone?.name||'Digital products',estimated_total_kobo:breakdown.totalKobo};
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
  if (params.sort === 'price-asc') order = 'p.price_kobo ASC,p.created_at DESC';
  if (params.sort === 'price-desc') order = 'p.price_kobo DESC,p.created_at DESC';
  if (params.sort === 'popular') order = 'p.views DESC,p.created_at DESC';
  const limit = Math.min(Math.max(Number(params.limit) || 24, 1), 60);
  values.push(limit);
  const { rows } = await db.query(
    `SELECT p.id,p.name,p.slug,p.description,p.product_type,p.price_kobo,p.compare_at_kobo,p.image_url,p.stock_qty,p.variants,p.featured,p.created_at,
       c.name AS category_name,c.slug AS category_slug,s.id AS seller_id,s.store_name,s.slug AS store_slug,s.city,s.state,
       COALESCE(rv.avg_rating,0) AS rating,COALESCE(rv.review_count,0) AS review_count
     FROM market_products p JOIN market_sellers s ON s.id=p.seller_id LEFT JOIN market_categories c ON c.id=p.category_id
     LEFT JOIN (SELECT product_id,round(avg(rating)::numeric,1) AS avg_rating,count(*) AS review_count FROM market_reviews GROUP BY product_id) rv ON rv.product_id=p.id
     WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${values.length}`,
    values
  );
  return rows;
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
  return rows[0];
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
  const targetTab=['orders','products','disputes','payouts','overview','growth','sellers'].includes(fields.target_tab)?fields.target_tab:'orders';
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
  const [products, orders, payouts, disputes, salesSummary, dailySales, topProducts] = await Promise.all([
    db.query(`SELECT p.id,p.name,p.price_kobo,p.compare_at_kobo,p.stock_qty,p.variants,p.status,p.product_type,p.created_at,p.description,p.image_url,p.sku,p.digital_delivery_url,c.name AS category_name,c.id AS category_id FROM market_products p LEFT JOIN market_categories c ON c.id=p.category_id WHERE p.seller_id=$1 ORDER BY p.created_at DESC LIMIT 100`,[seller.id]),
    db.query(`SELECT oi.id,oi.product_name,oi.quantity,oi.unit_price_kobo,oi.fulfillment_status,oi.tracking_number,oi.tracking_carrier,o.order_number,o.status,o.payment_status,o.created_at,o.recipient_name,o.phone,o.shipping_address,oi.buyer_confirmed_at
      FROM market_order_items oi JOIN market_orders o ON o.id=oi.order_id WHERE oi.seller_id=$1 AND o.payment_status='paid' ORDER BY o.created_at DESC LIMIT 100`,[seller.id]),
    db.query('SELECT id,gross_kobo,commission_kobo,net_kobo,status,payout_reference,eligible_at,hold_reason,created_at,paid_at FROM market_payouts WHERE seller_id=$1 ORDER BY created_at DESC LIMIT 100',[seller.id]),
    db.query(`SELECT d.*,o.order_number,oi.product_name,u.full_name AS buyer_name FROM market_disputes d
      JOIN market_orders o ON o.id=d.order_id JOIN market_order_items oi ON oi.id=d.order_item_id
      JOIN market_users u ON u.id=d.buyer_id WHERE d.seller_id=$1 ORDER BY d.opened_at DESC LIMIT 100`,[seller.id]),
    db.query(`SELECT COALESCE(sum(oi.unit_price_kobo::numeric*oi.quantity),0)::bigint AS all_time_sales_kobo,
      COALESCE(sum(oi.unit_price_kobo::numeric*oi.quantity) FILTER(WHERE o.created_at>=date_trunc('month',now())),0)::bigint AS current_month_sales_kobo,
      COALESCE(sum(oi.unit_price_kobo::numeric*oi.quantity) FILTER(WHERE o.created_at>=date_trunc('month',now())-interval '1 month' AND o.created_at<date_trunc('month',now())),0)::bigint AS previous_month_sales_kobo,
      count(DISTINCT o.id) AS all_time_orders,
      count(DISTINCT o.id) FILTER(WHERE o.created_at>=date_trunc('month',now())) AS current_month_orders,
      COALESCE(sum(oi.quantity),0)::bigint AS all_time_units,
      COALESCE(sum(oi.quantity) FILTER(WHERE o.created_at>=date_trunc('month',now())),0)::bigint AS current_month_units,
      COALESCE(sum(oi.commission_kobo),0)::bigint AS all_time_commission_kobo
      FROM market_order_items oi JOIN market_orders o ON o.id=oi.order_id
      WHERE oi.seller_id=$1 AND o.payment_status='paid'`,[seller.id]),
    db.query(`SELECT date_trunc('day',o.created_at)::date AS day,
      COALESCE(sum(oi.unit_price_kobo::numeric*oi.quantity),0)::bigint AS sales_kobo,
      count(DISTINCT o.id)::int AS orders,COALESCE(sum(oi.quantity),0)::bigint AS units
      FROM market_order_items oi JOIN market_orders o ON o.id=oi.order_id
      WHERE oi.seller_id=$1 AND o.payment_status='paid' AND o.created_at>=current_date-interval '13 days'
      GROUP BY date_trunc('day',o.created_at)::date ORDER BY day`,[seller.id]),
    db.query(`SELECT oi.product_id,oi.product_name,
      COALESCE(sum(oi.unit_price_kobo::numeric*oi.quantity),0)::bigint AS sales_kobo,
      COALESCE(sum(oi.quantity),0)::bigint AS units,count(DISTINCT o.id)::int AS orders
      FROM market_order_items oi JOIN market_orders o ON o.id=oi.order_id
      WHERE oi.seller_id=$1 AND o.payment_status='paid'
      GROUP BY oi.product_id,oi.product_name ORDER BY sales_kobo DESC,units DESC LIMIT 5`,[seller.id])
  ]);
  const totals = await db.query(`SELECT COALESCE(sum(net_kobo),0) AS net_total,COALESCE(sum(net_kobo) FILTER(WHERE status IN ('pending','approved','held')),0) AS outstanding,COALESCE(sum(net_kobo) FILTER(WHERE status='paid'),0) AS paid FROM market_payouts WHERE seller_id=$1`,[seller.id]);
  const growthProfile = await ensureGrowthProfile(db,user.id);
  return {
    seller: sellerPublic(seller), products: products.rows, orders: orders.rows,
    payouts: payouts.rows, disputes: disputes.rows, totals: totals.rows[0],
    sales_analytics: {summary:salesSummary.rows[0],daily:dailySales.rows,top_products:topProducts.rows},
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

async function saveProduct(db,req,body){
 const user=await requireRole(req,db,['seller','admin','super_admin']),seller=await getSellerByUser(db,user.id,true);
 const name=text(body.name,180),description=text(body.description,5000),type=body.product_type==='digital'?'digital':'physical',price=money(body.price_kobo),imageUrl=text(body.image_url,1000);
 if(name.length<3||description.length<10||price<100)throw new HttpError(400,'Add a product name, useful description and price of at least ₦1.');
 if(body.compare_at_kobo&&money(body.compare_at_kobo)<price)throw new HttpError(400,'The previous price must be higher than the selling price.');
 if(imageUrl&&!/^https:\/\//i.test(imageUrl))throw new HttpError(400,'Product image must use HTTPS.');
 if(type==='digital'&&body.digital_delivery_url&&!/^https:\/\//i.test(String(body.digital_delivery_url)))throw new HttpError(400,'Digital delivery links must use HTTPS.');
 const category=await db.query('SELECT id FROM market_categories WHERE (id::text=$1 OR slug=$1) AND is_active=true LIMIT 1',[text(body.category_id,100)]);
 if(!category.rows.length)throw new HttpError(400,'Choose a valid active product category.');
 const rawVariants=type==='physical'&&Array.isArray(body.variants)?body.variants:[];
 if(rawVariants.length>50)throw new HttpError(400,'A product can have up to 50 variations.');
 const seen=new Set(),variants=[];
 for(const raw of rawVariants){
  const label=text(raw.name,80),sku=text(raw.sku,80),variantPrice=raw.price_kobo===null||raw.price_kobo===undefined||raw.price_kobo===''?price:money(raw.price_kobo),stock=parseInt(raw.stock_qty,10);
  if(!label)throw new HttpError(400,'Every variation needs an option name, such as Small or Blue.');
  if(variantPrice<100)throw new HttpError(400,'Variation prices must be at least ₦1.');
  if(!Number.isInteger(stock)||stock<0||stock>100000)throw new HttpError(400,'Variation stock must be a whole number from 0 to 100,000.');
  const key=sku.toLowerCase();if(key&&seen.has(key))throw new HttpError(400,'Variation SKUs must be unique within this product.');if(key)seen.add(key);
  variants.push({id:/^[0-9a-f-]{36}$/i.test(String(raw.id||''))?String(raw.id):crypto.randomUUID(),name:label,sku,price_kobo:variantPrice,stock_qty:stock,active:true});
 }
 const stock=type==='digital'?999999:variants.length?variants.reduce((n,v)=>n+v.stock_qty,0):Math.min(Math.max(parseInt(body.stock_qty,10)||0,0),100000);
 if(type==='physical'&&stock<1)throw new HttpError(400,'A physical product needs at least one item in stock.');
 const productId=text(body.id,80),variantsJson=JSON.stringify(variants);
 if(productId){
  const result=await db.query("UPDATE market_products SET category_id=$3,name=$4,description=$5,product_type=$6,price_kobo=$7,compare_at_kobo=$8,image_url=$9,sku=$10,stock_qty=$11,digital_delivery_url=$12,variants=$13::jsonb,status='pending',featured=false,updated_at=now() WHERE id=$1 AND seller_id=$2 RETURNING id,name,status,price_kobo,product_type,stock_qty,variants",
  [productId,seller.id,category.rows[0].id,name,description,type,price,body.compare_at_kobo?money(body.compare_at_kobo):null,imageUrl,text(body.sku,80),stock,type==='digital'?text(body.digital_delivery_url,1500):'',variantsJson]);
  if(!result.rows.length)throw new HttpError(404,'Product was not found in your store.');
  await audit(db,user.id,'PRODUCT_UPDATED','product',productId,{variation_count:variants.length});return {product:result.rows[0]};
 }
 const slug=slugify(name)+'-'+crypto.randomBytes(2).toString('hex');
 const result=await db.query("INSERT INTO market_products(seller_id,category_id,name,slug,description,product_type,price_kobo,compare_at_kobo,image_url,sku,stock_qty,digital_delivery_url,variants,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,'pending') RETURNING id,name,status,price_kobo,product_type,stock_qty,variants",
 [seller.id,category.rows[0].id,name,slug,description,type,price,body.compare_at_kobo?money(body.compare_at_kobo):null,imageUrl,text(body.sku,80),stock,type==='digital'?text(body.digital_delivery_url,1500):'',variantsJson]);
 await audit(db,user.id,'PRODUCT_SUBMITTED','product',result.rows[0].id,{variation_count:variants.length});return {product:result.rows[0]};
}

async function bulkSaveProducts(db,req,body) {
  const user=await requireRole(req,db,['seller','admin','super_admin']);
  const seller=await getSellerByUser(db,user.id,true);
  const input=Array.isArray(body.products)?body.products:[];
  if(!input.length||input.length>100) throw new HttpError(400,'Upload between 1 and 100 products per batch.');
  const prepared=[],skuSeen=new Set(),categoryKeys=[...new Set(input.map(p=>text(p.category_id||p.category,100)).filter(Boolean))];
  const categoryResult=await db.query('SELECT id,slug,name FROM market_categories WHERE is_active=true AND (id::text=ANY($1::text[]) OR slug=ANY($1::text[]) OR lower(name)=ANY($2::text[]))',[categoryKeys,categoryKeys.map(x=>x.toLowerCase())]);
  const categories=new Map();
  for(const c of categoryResult.rows){categories.set(String(c.id),c);categories.set(c.slug.toLowerCase(),c);categories.set(c.name.toLowerCase(),c);}
  const errors=[];
  for(let i=0;i<input.length;i++){
    const row=input[i]||{},rowNumber=Number(row.row_number)||i+2;
    const name=text(row.name,180),description=text(row.description,1000);
    const type=row.product_type==='digital'?'digital':'physical';
    const price=money(row.price_kobo),compare=row.compare_at_kobo?money(row.compare_at_kobo):null;
    const stock=type==='digital'?999999:parseInt(row.stock_qty,10);
    const imageUrl=text(row.image_url,1000),digitalUrl=text(row.digital_delivery_url,1500);
    const sku=text(row.sku,80),categoryKey=text(row.category_id||row.category,100);
    const category=categories.get(categoryKey)||categories.get(categoryKey.toLowerCase());
    const rowErrors=[];
    if(name.length<3)rowErrors.push('Product name must be at least 3 characters.');
    if(description.length<10)rowErrors.push('Description must be at least 10 characters.');
    if(!category)rowErrors.push('Choose a valid active category (use the category slug).');
    if(price<100)rowErrors.push('Selling price must be at least ₦1.');
    if(compare!==null&&compare<=price)rowErrors.push('Previous price must be higher than selling price.');
    if(type==='physical'&&(!Number.isInteger(stock)||stock<1||stock>100000))rowErrors.push('Physical stock must be a whole number from 1 to 100,000.');
    if(imageUrl&&!/^https:\/\//i.test(imageUrl))rowErrors.push('Image URL must use HTTPS.');
    if(type==='digital'&&digitalUrl&&!/^https:\/\//i.test(digitalUrl))rowErrors.push('Digital delivery URL must use HTTPS.');
    const skuKey=sku.toLowerCase();
    if(skuKey&&skuSeen.has(skuKey))rowErrors.push('SKU is duplicated within this upload.');
    if(skuKey)skuSeen.add(skuKey);
    if(rowErrors.length)errors.push({row:rowNumber,errors:rowErrors});
    else prepared.push({rowNumber,name,description,type,price,compare,stock,imageUrl,digitalUrl,sku,categoryId:category.id});
  }
  if(errors.length)throw new HttpError(400,'Some rows need attention: '+errors.slice(0,5).map(e=>'Row '+e.row+': '+e.errors.join(' ')).join(' '));
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    const skuList=prepared.map(p=>p.sku.toLowerCase()).filter(Boolean);
    if(skuList.length){
      const duplicate=await client.query("SELECT lower(sku) AS sku FROM market_products WHERE seller_id=$1 AND sku<>'' AND lower(sku)=ANY($2::text[])",[seller.id,skuList]);
      if(duplicate.rows.length)throw new HttpError(409,'One or more SKUs already exist in your store: '+duplicate.rows.slice(0,5).map(x=>x.sku).join(', '));
    }
    const created=[];
    for(const p of prepared){
      const slug=slugify(p.name)+'-'+crypto.randomBytes(3).toString('hex');
      const result=await client.query("INSERT INTO market_products(seller_id,category_id,name,slug,description,product_type,price_kobo,compare_at_kobo,image_url,sku,stock_qty,digital_delivery_url,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending') RETURNING id,name,status,price_kobo,product_type,stock_qty",[seller.id,p.categoryId,p.name,slug,p.description,p.type,p.price,p.compare,p.imageUrl,p.sku,p.stock,p.type==='digital'?p.digitalUrl:'']);
      created.push(result.rows[0]);
      await audit(client,user.id,'PRODUCT_BULK_SUBMITTED','product',result.rows[0].id,{batch_size:prepared.length,source_row:p.rowNumber});
    }
    await client.query('COMMIT');
    return {created_count:created.length,products:created,status:'pending'};
  }catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}
  finally{client.release();}
}

async function resolveDeliveryZone(db,state,city) {
  const cleanState=text(state,80).trim().toLowerCase();
  const cleanCity=text(city,80).trim().toLowerCase();
  const {rows}=await db.query(
    `SELECT id,name,state,city,fee_kobo FROM market_delivery_zones
     WHERE active=true AND (lower(state)=$1 OR state='*')
       AND (lower(city)=$2 OR city='*')
     ORDER BY CASE WHEN state<>'*' THEN 0 ELSE 1 END,
       CASE WHEN city<>'*' THEN 0 ELSE 1 END LIMIT 1`,[cleanState,cleanCity]
  );
  if(!rows.length) throw new HttpError(409,'Delivery pricing is not configured for this location yet. Please contact ETHAN MARKET support.');
  return {...rows[0],fee_kobo:Number(rows[0].fee_kobo)};
}

async function checkout(db, req, body) {
  if (!process.env.PAYSTACK_SECRET_KEY) throw new HttpError(503,'Secure checkout is being connected. Marketplace browsing and seller registration are available, but payment is not enabled yet.');
  const user = await requireRole(req, db, ['buyer','seller','admin','super_admin']);
  await rateLimit(db, 'checkout', user.id, 10, 60);
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length || items.length > 30) throw new HttpError(400,'Your cart is empty or contains too many products.');
  const quantities=new Map();
  for(const item of items){const id=text(item.product_id,80),variantId=text(item.variant_id,80),q=Math.min(Math.max(parseInt(item.quantity,10)||0,0),20);if(!/^[0-9a-f-]{36}$/i.test(id)||q<1)throw new HttpError(400,'Your cart contains an invalid item.');const key=id+'|'+variantId;quantities.set(key,(quantities.get(key)||0)+q);if(quantities.get(key)>20)throw new HttpError(400,'A product variation quantity cannot exceed 20 per checkout.');}
  const dbClient = await db.connect();
  let order;
  try {
    await dbClient.query('BEGIN');
    await dbClient.query(
      `UPDATE market_promo_redemptions r SET status='expired' FROM market_orders o
       WHERE r.order_id=o.id AND r.status='reserved' AND (o.payment_status<>'pending' OR o.created_at<now()-interval '30 minutes')`
    );
    await dbClient.query("UPDATE market_orders SET payment_status='failed',status='cancelled',updated_at=now() WHERE payment_status='pending' AND created_at < now()-interval '30 minutes'");
    const ids=[...new Set([...quantities.keys()].map(k=>k.split('|')[0]))];
    const { rows: products } = await dbClient.query(
      `SELECT p.*,s.id AS approved_seller_id,s.commission_bps,s.store_name FROM market_products p
       JOIN market_sellers s ON s.id=p.seller_id WHERE p.id=ANY($1::uuid[]) AND p.status='active' AND s.seller_status='approved' FOR UPDATE OF p`, [ids]
    );
    if (products.length !== ids.length) throw new HttpError(409,'One or more products are no longer available. Refresh your cart.');
    let subtotal=0,physical=false,marketplaceFee=0;
    const orderId=crypto.randomUUID(),orderNumber='EM-'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'-'+crypto.randomBytes(3).toString('hex').toUpperCase(),ref='EM'+Date.now().toString()+crypto.randomBytes(5).toString('hex').toUpperCase(),itemSnapshots=[];
    for(const p of products){
      const lines=[...quantities.entries()].filter(([key])=>key.startsWith(p.id+'|')),variants=Array.isArray(p.variants)?p.variants:[];let productQuantity=0;
      for(const [key,quantity] of lines){
        const variantId=key.slice(p.id.length+1);let variant=null,unitPrice=Number(p.price_kobo),variantLabel='';
        if(variants.length){variant=variants.find(v=>v.id===variantId&&v.active!==false);if(!variant)throw new HttpError(409,'Choose an available variation for '+p.name+'.');unitPrice=Number(variant.price_kobo);variantLabel=String(variant.name||'');
          if(p.product_type==='physical'){const reserved=await dbClient.query("SELECT COALESCE(sum(oi.quantity),0)::int AS quantity FROM market_order_items oi JOIN market_orders o ON o.id=oi.order_id WHERE oi.product_id=$1 AND oi.variant_id=$2 AND o.payment_status='pending' AND o.created_at>=now()-interval '30 minutes'",[p.id,variantId]);const available=Number(variant.stock_qty)-Number(reserved.rows[0]?.quantity||0);if(available<quantity)throw new HttpError(409,variant.name+' has only '+Math.max(available,0)+' item(s) currently available.');}
        }else if(variantId)throw new HttpError(409,'This product variation is no longer available.');
        productQuantity+=quantity;const gross=unitPrice*quantity,commission=calculateCommissionKobo(gross,Number(p.commission_bps));subtotal+=gross;marketplaceFee+=commission;if(p.product_type==='physical')physical=true;
        itemSnapshots.push({p,quantity,commission,net:gross-commission,variantId,variantLabel,unitPrice});
      }
      if(p.product_type==='physical'&&productQuantity){const reserved=await dbClient.query("SELECT COALESCE(sum(oi.quantity),0)::int AS quantity FROM market_order_items oi JOIN market_orders o ON o.id=oi.order_id WHERE oi.product_id=$1 AND oi.product_type='physical' AND o.payment_status='pending' AND o.created_at>=now()-interval '30 minutes'",[p.id]);const available=Number(p.stock_qty)-Number(reserved.rows[0]?.quantity||0);if(available<productQuantity)throw new HttpError(409,p.name+' has only '+Math.max(available,0)+' item(s) currently available.');}
    }
    if (!Number.isSafeInteger(subtotal) || subtotal < 100) throw new HttpError(400,'The cart total is invalid.');
    const deliveryZone = physical ? await resolveDeliveryZone(dbClient,body.state,body.city) : null;
    const shipping = physical ? deliveryZone.fee_kobo : 0;
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
    const checkoutBreakdown=calculateCheckoutBreakdown({subtotalKobo:subtotal,deliveryKobo:shipping,discountKobo:discount});
    const total = checkoutBreakdown.totalKobo;
    const recipient = text(body.recipient_name || user.full_name,120);
    const phone = text(body.phone || user.phone,40);
    const address = {
      line1:text(body.address_line1,180),line2:text(body.address_line2,180),city:text(body.city,80),
      state:text(body.state,80),postal_code:text(body.postal_code,30),country:'Nigeria',
      delivery_zone_id:deliveryZone?.id||null,delivery_zone_name:deliveryZone?.name||'',
      delivery_fee_kobo:shipping,delivery_pricing_mode:physical?'zone':'none'
    };
    if (physical && (!recipient || !phone || !address.line1 || !address.city || !address.state)) throw new HttpError(400,'Complete the delivery name, phone, street, city and state for physical items.');
    await dbClient.query(
      `INSERT INTO market_orders(id,order_number,buyer_id,buyer_email,recipient_name,phone,subtotal_kobo,shipping_kobo,total_kobo,paystack_reference,shipping_address,buyer_note,discount_kobo,promo_code,campaign_slug,affiliate_user_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [orderId,orderNumber,user.id,user.email,recipient,phone,subtotal,shipping,total,ref,JSON.stringify(address),text(body.buyer_note,1000),discount,promo?.code||'',campaignSlug,affiliateUser]
    );
    for (const it of itemSnapshots) {
      await dbClient.query(
        `INSERT INTO market_order_items(order_id,product_id,seller_id,product_name,product_type,quantity,unit_price_kobo,commission_kobo,seller_net_kobo,digital_delivery_url,fulfillment_status,variant_id,variant_label)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [orderId,it.p.id,it.p.seller_id,it.p.name+(it.variantLabel?' — '+it.variantLabel:''),it.p.product_type,it.quantity,it.unitPrice,it.commission,it.net,it.p.product_type==='digital'?text(it.p.digital_delivery_url,1500):'',it.p.product_type==='digital'?'delivered':'unfulfilled',it.variantId,it.variantLabel]
      );
    }
    await dbClient.query('INSERT INTO market_payments(order_id,reference,amount_kobo) VALUES($1,$2,$3)',[orderId,ref,total]);
    if(promo) await dbClient.query(
      `INSERT INTO market_promo_redemptions(promo_id,order_id,user_id,discount_kobo,status)
       VALUES($1,$2,$3,$4,'reserved')`,[promo.id,orderId,user.id,discount]
    );
    await trackGrowthEvent(dbClient,{event_type:'checkout_started',user_id:user.id,order_id:orderId,campaign_slug:campaignSlug,metadata:{promo_code:promo?.code||'',affiliate_attributed:!!affiliateUser}});
    await dbClient.query('COMMIT');
    order={id:orderId,order_number:orderNumber,reference:ref,total_kobo:total,email:user.email,discount_kobo:discount,promo_code:promo?.code||''};
  } catch(e) { await dbClient.query('ROLLBACK'); throw e; }
  finally { dbClient.release(); }

  const callback = (process.env.MARKET_PUBLIC_URL || 'https://market.ethandigitalacademy.org').replace(/\/$/,'') + '/?payment=verify';
  try {
    const gateway = await paystack('/transaction/initialize', {
      method:'POST',
      body:{email:order.email,amount:String(order.total_kobo),currency:'NGN',reference:order.reference,callback_url:callback,
        metadata:{order_id:order.id,order_number:order.order_number,app:'ETHAN MARKET'},channels:['card','bank','bank_transfer','ussd']}
    });
    if (!gateway?.data?.authorization_url) throw new HttpError(502,'Paystack did not return a checkout link.');
    return { authorization_url:gateway.data.authorization_url,reference:order.reference,order_number:order.order_number,total_kobo:order.total_kobo };
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

async function finalizePaid(db, transaction) {
  if (!transaction || transaction.status !== 'success' || !transaction.reference) throw new HttpError(400,'This transaction has not been confirmed as successful.');
  const client = await db.connect();
  let orderInfo;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM market_orders WHERE paystack_reference=$1 FOR UPDATE',[String(transaction.reference)]);
    if (!rows.length) throw new HttpError(404,'No ETHAN MARKET order matches this payment reference.');
    const order = rows[0];
    if (Number(transaction.amount) !== Number(order.total_kobo) || String(transaction.currency).toUpperCase() !== 'NGN') throw new HttpError(400,'The payment amount or currency does not match this order.');
    const providerFee=Math.max(0,Number(transaction.fees)||0);
    if(providerFee>0) await client.query(
      "UPDATE market_payments SET gateway_fee_kobo=$2,gateway_fee_recorded_at=now() WHERE reference=$1 AND gateway_fee_kobo=0",
      [String(transaction.reference),providerFee]
    );
    if (order.payment_status !== 'paid') {
      await client.query("UPDATE market_orders SET payment_status='paid',status=CASE WHEN NOT EXISTS(SELECT 1 FROM market_order_items WHERE order_id=$1 AND product_type='physical') THEN 'delivered' ELSE 'processing' END,payment_verified_at=now(),updated_at=now() WHERE id=$1",[order.id]);
      await client.query("UPDATE market_payments SET status='success',gateway_payload=$2::jsonb,verified_at=now() WHERE reference=$1",[String(transaction.reference),JSON.stringify(transaction)]);
      const { rows:changed } = await client.query('UPDATE market_order_items SET stock_deducted=true WHERE order_id=$1 AND product_type=\'physical\' AND stock_deducted=false RETURNING product_id,quantity,variant_id',[order.id]);
      for(const row of changed)if(row.product_id){await client.query('UPDATE market_products SET stock_qty=GREATEST(stock_qty-$2,0),updated_at=now() WHERE id=$1',[row.product_id,row.quantity]);if(row.variant_id)await client.query("UPDATE market_products SET variants=(SELECT COALESCE(jsonb_agg(CASE WHEN v->>'id'=$2 THEN jsonb_set(v,'{stock_qty}',to_jsonb(GREATEST(COALESCE((v->>'stock_qty')::int,0)-$3,0))) ELSE v END),'[]'::jsonb) FROM jsonb_array_elements(variants) v),updated_at=now() WHERE id=$1",[row.product_id,row.variant_id,row.quantity]);}
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
  const { rows } = await db.query('SELECT id,buyer_id FROM market_orders WHERE paystack_reference=$1',[reference]);
  if (!rows.length) throw new HttpError(404,'Order not found.');
  if (rows[0].buyer_id !== user.id && !['admin','super_admin'].includes(user.role)) throw new HttpError(403,'This order does not belong to your account.');
  const verified = await paystack('/transaction/verify/'+encodeURIComponent(reference));
  const order = await finalizePaid(db,verified.data);
  return { order };
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

async function webhook(req,res,db) {
  const raw = await readRaw(req);
  if (!verifyWebhookSignature(req,raw)) return send(res,401,{error:'Invalid payment webhook signature.'});
  let event;
  try { event=JSON.parse(raw.toString('utf8')); } catch { return send(res,400,{error:'Invalid webhook payload.'}); }
  if (event.event === 'charge.success' && event.data?.reference) {
    try {
      const verification=await paystack('/transaction/verify/'+encodeURIComponent(event.data.reference));
      await finalizePaid(db,verification.data);
    } catch (e) {
      console.error('ETHAN MARKET webhook processing failed:',e.message);
      return send(res,500,{error:'Webhook could not be processed. Paystack may retry.'});
    }
  }
  return send(res,200,{received:true});
}

async function buyerOrders(db,req) {
  const user=await currentUser(req,db,true);
  const {rows}=await db.query(
    `SELECT o.id,o.order_number,o.subtotal_kobo,o.shipping_kobo,o.total_kobo,o.payment_status,o.status,o.created_at,
      json_agg(json_build_object('id',oi.id,'product_id',oi.product_id,'product_name',oi.product_name,'product_type',oi.product_type,'quantity',oi.quantity,
       'unit_price_kobo',oi.unit_price_kobo,'fulfillment_status',oi.fulfillment_status,'tracking_number',oi.tracking_number,'tracking_carrier',oi.tracking_carrier,
       'buyer_confirmed_at',oi.buyer_confirmed_at,'delivered_at',oi.delivered_at,'payout_status',p.status,'payout_eligible_at',p.eligible_at,
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
  const [orders,products,sellers,payouts,recent,finance]=await Promise.all([
    db.query(`SELECT count(*) AS count,COALESCE(sum(total_kobo) FILTER(WHERE payment_status='paid'),0) AS gmv,
      count(*) FILTER(WHERE payment_status='paid') AS paid_orders,count(*) FILTER(WHERE payment_status='pending') AS awaiting_payment FROM market_orders`),
    db.query("SELECT count(*) AS total,count(*) FILTER(WHERE status='active') AS active,count(*) FILTER(WHERE status='pending') AS pending FROM market_products"),
    db.query("SELECT count(*) AS total,count(*) FILTER(WHERE seller_status='approved') AS approved,count(*) FILTER(WHERE seller_status='pending') AS pending FROM market_sellers"),
    db.query("SELECT count(*) AS count,COALESCE(sum(net_kobo) FILTER(WHERE status IN ('pending','approved','held')),0) AS outstanding FROM market_payouts"),
    db.query(`SELECT o.id,o.order_number,o.buyer_email,o.total_kobo,o.payment_status,o.status,o.created_at FROM market_orders o ORDER BY o.created_at DESC LIMIT 8`),
    db.query(`SELECT
      COALESCE((SELECT sum(oi.commission_kobo) FROM market_order_items oi JOIN market_orders o ON o.id=oi.order_id WHERE o.payment_status='paid'),0)::bigint AS marketplace_commission_kobo,
      COALESCE((SELECT sum(p.gateway_fee_kobo) FROM market_payments p JOIN market_orders o ON o.id=p.order_id WHERE o.payment_status='paid'),0)::bigint AS gateway_fee_kobo`)
  ]);
  return {orders:orders.rows[0],products:products.rows[0],sellers:sellers.rows[0],payouts:payouts.rows[0],recent:recent.rows,finance:finance.rows[0]};
}

async function adminList(db,req,kind) {
  await requireRole(req,db,['admin','super_admin']);
  if(kind==='sellers') {
    const {rows}=await db.query(`SELECT s.*,u.full_name,u.email,u.phone FROM market_sellers s JOIN market_users u ON u.id=s.user_id ORDER BY CASE s.seller_status WHEN 'pending' THEN 0 ELSE 1 END,s.created_at DESC LIMIT 250`);
    return {sellers:rows.map(s=>({...sellerPublic(s),user_name:s.full_name,email:s.email,user_phone:s.phone}))};
  }
  if(kind==='products') {
    const {rows}=await db.query(`SELECT p.*,s.store_name,c.name AS category_name FROM market_products p JOIN market_sellers s ON s.id=p.seller_id LEFT JOIN market_categories c ON c.id=p.category_id ORDER BY CASE p.status WHEN 'pending' THEN 0 ELSE 1 END,p.created_at DESC LIMIT 250`);
    return {products:rows};
  }
  if(kind==='orders') {
    const {rows}=await db.query(`SELECT o.*,COALESCE(json_agg(json_build_object('id',i.id,'product_name',i.product_name,'product_type',i.product_type,'quantity',i.quantity,'seller_id',i.seller_id,'fulfillment_status',i.fulfillment_status,'tracking_number',i.tracking_number,'tracking_carrier',i.tracking_carrier)) FILTER(WHERE i.id IS NOT NULL),'[]'::json) AS items FROM market_orders o LEFT JOIN market_order_items i ON i.order_id=o.id GROUP BY o.id ORDER BY o.created_at DESC LIMIT 250`);
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
  if(kind==='settings') {
    const [settings,zones]=await Promise.all([
      getSettings(db),
      db.query(`SELECT id,name,state,city,fee_kobo,active,is_fallback FROM market_delivery_zones ORDER BY is_fallback DESC,state,city,name`)
    ]);
    return {settings,delivery_zones:zones.rows};
  }
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
  if(action==='admin.delivery-zone-save') {
    const zoneId=text(body.id,80),name=text(body.name,100).trim();
    const state=text(body.state,80).trim()||'*',city=text(body.city,80).trim()||'*',fee=money(body.fee_kobo);
    if(name.length<3||(!/^[a-z0-9 -]{1,80}$/i.test(state)&&state!=='*')||(!/^[a-z0-9 -]{1,80}$/i.test(city)&&city!=='*'))
      throw new HttpError(400,'Enter a valid zone name, state/city (or * for any), and delivery fee.');
    if(zoneId) {
      const updated=await db.query(`UPDATE market_delivery_zones SET name=$2,state=$3,city=$4,fee_kobo=$5,updated_at=now() WHERE id=$1 RETURNING id`,[zoneId,name,state,city,fee]);
      if(!updated.rows.length) throw new HttpError(404,'Delivery zone not found.');
    } else {
      try { await db.query(`INSERT INTO market_delivery_zones(name,state,city,fee_kobo,is_fallback) VALUES($1,$2,$3,$4,$5)`,[name,state,city,fee,state==='*'&&city==='*']); }
      catch(error) { if(error.code==='23505') throw new HttpError(409,'A delivery zone already exists for that state and city. Edit the existing zone instead.'); throw error; }
    }
    await audit(db,user.id,'DELIVERY_ZONE_SAVED','delivery_zone',zoneId||name,{state,city,fee_kobo:fee});
    const zones=await db.query(`SELECT id,name,state,city,fee_kobo,active,is_fallback FROM market_delivery_zones ORDER BY is_fallback DESC,state,city,name`);
    return {ok:true,delivery_zones:zones.rows};
  }
  if(action==='admin.delivery-zone-status') {
    const active=body.active===true;
    const updated=await db.query(`UPDATE market_delivery_zones SET active=$2,updated_at=now() WHERE id=$1 AND is_fallback=false RETURNING id`,[id,active]);
    if(!updated.rows.length) throw new HttpError(400,'The nationwide fallback zone cannot be deactivated.');
    await audit(db,user.id,'DELIVERY_ZONE_STATUS_CHANGED','delivery_zone',id,{active});
    return {ok:true};
  }
  if(action==='admin.settings') {
    const commission=Math.min(Math.max(parseInt(body.commission_bps,10)||0,0),5000);
    const holdDays=Math.min(30,Math.max(1,parseInt(body.seller_payout_hold_days,10)||7));
    await db.query("INSERT INTO market_settings(key,value) VALUES('commission_bps',$1::jsonb),('seller_payout_hold_days',$2::jsonb),('payment_processing_bearer','\"ethan\"'::jsonb),('delivery_pricing_mode','\"zone\"'::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[JSON.stringify(commission),JSON.stringify(holdDays)]);
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
  if(action==='health') return {status:'ok',service:'ETHAN MARKET',database:'connected',payments:!!process.env.PAYSTACK_SECRET_KEY};
  if(action==='market.config') { const settings=await getSettings(db); return { marketplace_name:'ETHAN MARKET', shipping_kobo:Number(settings.physical_shipping_kobo ?? 200000), commission_bps:Number(settings.commission_bps ?? 500), delivery_pricing_mode:'zone', payment_processing_bearer:'ethan', seller_payout_hold_days:Math.min(30,Math.max(1,Number(settings.seller_payout_hold_days)||7)), payments_enabled:!!process.env.PAYSTACK_SECRET_KEY, support_email:String(settings.support_email || 'ethandigitalacademy@gmail.com') }; }
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
  if(action==='seller.products.bulk') return bulkSaveProducts(db,req,body);
  if(action==='seller.fulfill') return sellerFulfill(db,req,body);
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
  if(action==='checkout.preview') return checkoutPreview(db,req,body);
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
      try { await ensureSchema(); return send(res,200,{status:'ok',service:'ETHAN MARKET',database:'connected',payments:!!process.env.PAYSTACK_SECRET_KEY,uploads:!!process.env.BLOB_READ_WRITE_TOKEN}); }
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
