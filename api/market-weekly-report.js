'use strict';

const crypto = require('node:crypto');
const { Pool } = require('pg');

let pool;
function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) throw new Error('Marketplace database is not configured.');
  const parsed = new URL(process.env.DATABASE_URL);
  parsed.searchParams.delete('channel_binding');
  parsed.searchParams.delete('sslmode');
  pool = new Pool({
    connectionString: parsed.toString(),
    ssl: { rejectUnauthorized: true },
    max: 2,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    application_name: 'ethan-market-weekly-reports'
  });
  return pool;
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(data));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });
  const secret = String(process.env.CRON_SECRET || '');
  if (!secret) return send(res, 503, { error: 'Weekly report schedule is not configured.' });
  const supplied = String(req.headers.authorization || '');
  const expected = 'Bearer ' + secret;
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    return send(res, 401, { error: 'Unauthorised.' });
  }
  try {
    const result = await getPool().query(`
      WITH seller_week AS (
        SELECT s.id AS seller_id, s.user_id, s.store_name,
          date_trunc('week', now())::date AS report_week,
          COALESCE(sum(oi.unit_price_kobo::numeric * oi.quantity)
            FILTER (WHERE o.payment_status='paid' AND o.created_at>=now()-interval '7 days'),0)::bigint AS current_sales_kobo,
          COALESCE(sum(oi.unit_price_kobo::numeric * oi.quantity)
            FILTER (WHERE o.payment_status='paid' AND o.created_at>=now()-interval '14 days' AND o.created_at<now()-interval '7 days'),0)::bigint AS previous_sales_kobo,
          count(DISTINCT o.id) FILTER (WHERE o.payment_status='paid' AND o.created_at>=now()-interval '7 days')::int AS current_orders,
          count(DISTINCT o.id) FILTER (WHERE o.payment_status='paid' AND o.created_at>=now()-interval '14 days' AND o.created_at<now()-interval '7 days')::int AS previous_orders,
          COALESCE(sum(oi.quantity) FILTER (WHERE o.payment_status='paid' AND o.created_at>=now()-interval '7 days'),0)::bigint AS current_units,
          COALESCE(sum(oi.quantity) FILTER (WHERE o.payment_status='paid' AND o.created_at>=now()-interval '14 days' AND o.created_at<now()-interval '7 days'),0)::bigint AS previous_units
        FROM market_sellers s
        LEFT JOIN market_order_items oi ON oi.seller_id=s.id
        LEFT JOIN market_orders o ON o.id=oi.order_id AND o.payment_status='paid'
        WHERE s.seller_status='approved'
        GROUP BY s.id,s.user_id,s.store_name
      )
      INSERT INTO market_notifications(user_id,type,title,message,target_tab,dedupe_key,metadata)
      SELECT user_id,'seller_weekly_sales_report','Your weekly sales report',
        'Your store ' || store_name || ': ₦' || to_char(current_sales_kobo/100.0,'FM999,999,999,990.00') ||
        ' in paid sales, ' || current_orders || ' order(s), and ' || current_units || ' unit(s) over the last 7 days. ' ||
        CASE WHEN previous_sales_kobo>0 THEN
          'Sales ' || CASE WHEN current_sales_kobo>=previous_sales_kobo THEN 'increased' ELSE 'decreased' END ||
          ' by ' || abs(round((current_sales_kobo-previous_sales_kobo)::numeric*100/previous_sales_kobo))::text ||
          '% compared with the previous 7 days.'
        ELSE 'No previous-week sales baseline yet.' END,
        'overview',
        'seller-weekly-report:' || seller_id::text || ':' || report_week::text,
        jsonb_build_object(
          'seller_id',seller_id,'report_week',report_week,
          'current_sales_kobo',current_sales_kobo,'previous_sales_kobo',previous_sales_kobo,
          'current_orders',current_orders,'previous_orders',previous_orders,
          'current_units',current_units,'previous_units',previous_units
        )
      FROM seller_week
      ON CONFLICT(user_id,dedupe_key) WHERE dedupe_key<>'' DO NOTHING
      RETURNING user_id
    `);
    return send(res, 200, { ok: true, report_week: new Date().toISOString().slice(0,10), notifications_created: result.rowCount || 0 });
  } catch (error) {
    console.error('ETHAN MARKET weekly report cron failed:', error.message);
    return send(res, 500, { error: 'Weekly reports could not be generated.' });
  }
};
