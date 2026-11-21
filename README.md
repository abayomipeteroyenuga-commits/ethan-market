# ETHAN MARKET

ETHAN MARKET is a multi-vendor marketplace for physical and digital products, powered by Ethan Digital Academy. It has a public storefront, buyer accounts, seller onboarding and store pages, a seller workspace, a marketplace administration dashboard, order tracking, product moderation, a wishlist, reviews, image uploads, and Monnify integration.

## Stack

- Static storefront: HTML, CSS and browser JavaScript, installable as a PWA
- API: Vercel Functions (Node.js 22+)
- Database: PostgreSQL 17 on a dedicated Neon project
- Public product images: Vercel Blob
- Payments: Monnify hosted checkout, server-side transaction verification and signed webhooks
- Currency: NGN; monetary values are stored as integer kobo

## Main routes

- Storefront: `https://market.ethandigitalacademy.org/`
- Product SEO pages: `/product/{slug}/{product-id}`
- Seller storefronts: `/store/{store-slug}`
- Buyer protection information: `/buyer-protection`
- Dynamic product and store sitemaps: `/sitemap-products.xml`, `/sitemap-stores.xml`
- Marketplace API: `/api/market`
- Payment webhook: `/api/market-webhook`
- Product image upload: `/api/market-upload`
- Database health check: `/api/market?health=1`

## Revenue model

The marketplace's configured seller commission is the primary current platform revenue stream. The default is 10% (1,000 basis points) of the product subtotal and can be changed by an administrator. Delivery charges are separate from the commission and should not automatically be reported as profit. Additional monetisation such as paid featured listings or seller subscriptions is a future option, not part of the current live revenue model.

### Features

### Buyers

- Browse approved stores and published products
- Search, category/type filters, sort, product details and seller storefronts
- Persistent shopping bag and wishlist
- Buyer registration/login and order history
- Monnify hosted checkout (once merchant credentials and contract code are configured)
- Server-side payment verification and webhook fulfilment
- Digital delivery links are shown only in paid order history; physical order tracking is shown in the same area
- Buyer receipt confirmation and per-item dispute opening
- Seller dispute-response workspace and administrator case resolution
- Product reviews after delivery

### Sellers

- Seller application and approval workflow
- Store profile, location and contact details
- Bank settlement details encrypted at rest with AES-256-GCM
- Product listing and image upload
- Physical inventory and digital product delivery link fields
- Seller dashboard for listings, paid orders, delivery tracking and settlement ledger

### Marketplace administration

- Overview of paid GMV, orders, stores and seller balances
- Seller approval/rejection/suspension
- Product approval/rejection/feature controls
- Order status monitoring
- Commission and delivery-fee settings
- Seller settlement ledger with account details and transfer reference
- Dispute queue and conditional seller-payout approval

## Growth and acquisition system

The admin dashboard includes a Growth workspace for acquisition campaigns, promo codes, referral reporting and affiliate review.

- Every existing buyer and seller receives a personal referral code and shareable invite link.
- Referral attribution is captured on registration and retained through later checkout; reports count sign-ups, first paid purchases and approved sellers.
- Campaign links use UTM-style `utm_campaign`, `utm_source` and `utm_medium` values. The dashboard reports visits, sign-up views, registrations, paid orders and GMV by campaign.
- Administrators can create, pause and reactivate campaigns and can create/deactivate promo codes with discount limits, minimum basket values and redemption caps.
- Promo discounts are calculated server-side and capped by the marketplace fee for the affected basket, so seller net earnings are not reduced by the promotion.
- Buyers and sellers may apply to the affiliate programme. Administrators approve participants and configure their share of ETHAN MARKET's marketplace fee. Eligible conversions are recorded for review; affiliate transfers are manually approved and recorded, not automatic.
- Affiliate rewards on an order are voided when a buyer dispute is resolved in the buyer's favour.
- Growth events include page/product/store views and signup/checkout activity. Tracking is rate limited and is not an assurance of unique human visitors.
- Buyers can share personal invite links using the native device share sheet or WhatsApp. Approved sellers receive a share-ready store URL and direct links for their active products in the Grow & refer workspace.
- Marketplace administrators have a launch-message kit for buyer and seller outreach, alongside campaign-specific tracking links for channel attribution.

## Payment behaviour

New ETHAN MARKET orders use Monnify hosted checkout. The backend authenticates with the Monnify API using server-side credentials, creates a transaction with a unique payment reference, and redirects the buyer to Monnify's secure checkout page. A browser redirect alone never marks an order as paid: ETHAN MARKET queries Monnify server-to-server and checks the exact payment reference, NGN currency, paid status and amount received before it changes the order to paid.

Monnify transaction-completion webhooks are checked using the Monnify signature in production, and the transaction is then independently verified against Monnify before fulfilment. Finalisation is idempotent, so repeat notifications cannot deduct stock or create seller payout records twice. Legacy Paystack verification remains only for historical orders created before the Monnify migration.

Seller transfers are **not automatically initiated** by this release. The dashboard provides an internal payable ledger. Physical-item payouts remain ineligible until the buyer confirms receipt; digital-item payouts receive the configured protection period (default 7 days). An open dispute changes an unpaid payout to held. After the protection period and dispute review, an administrator may approve a payout, complete the external bank/provider transfer, and record its cleared reference.

This ledger is an operational control, **not escrow custody**. ETHAN MARKET must not claim that it independently holds or safeguards customer funds. Do not enable direct seller splits for protected orders unless an approved settlement design preserves the agreed protection period.

Buyer-favour dispute resolutions require the administrator to complete the refund through the payment provider first and record the provider's refund reference. ETHAN MARKET records the decision; this release does not automatically issue provider refunds.

## Environment variables

Set these in the Vercel project environment (server-side only):

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Dedicated ETHAN MARKET Neon connection string |
| `MARKET_PUBLIC_URL` | Canonical marketplace origin |
| `MARKET_SUPER_ADMIN_EMAIL` | Initial marketplace owner email |
| `MARKET_OWNER_BOOTSTRAP_TOKEN` | One-time owner activation code; remove after owner registration |
| `MARKET_FIELD_ENCRYPTION_KEY` | 32-byte hex key for payout account fields |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob upload token |
| `MONNIFY_API_KEY` | Monnify test or live API key |
| `MONNIFY_SECRET_KEY` | Monnify test or live secret key; also used to validate production webhooks |
| `MONNIFY_CONTRACT_CODE` | Monnify merchant contract code |
| `MONNIFY_BASE_URL` | `https://sandbox.monnify.com` for testing or `https://api.monnify.com` for live payments |

Do not commit real secrets or expose Monnify credentials in browser code. See `.env.example` for the variable names only.

## First-time owner activation

1. Open the production storefront and choose **Create account**.
2. Register using the configured owner email.
3. Enter the one-time owner activation code provided separately by the marketplace operator.
4. After the owner account is successfully created, remove `MARKET_OWNER_BOOTSTRAP_TOKEN` from Vercel and redeploy. The database also prevents a second owner activation.

## Monnify setup before live transactions

1. Add the Monnify **test** API key as `MONNIFY_API_KEY` in the Vercel project environment.
2. Add the matching test secret key as `MONNIFY_SECRET_KEY` and your merchant contract code as `MONNIFY_CONTRACT_CODE`.
3. Set `MONNIFY_BASE_URL=https://sandbox.monnify.com` while testing. Keep all credentials server-side and encrypted in Vercel.
4. In the Monnify dashboard, register `https://market.ethandigitalacademy.org/api/market-webhook` as the transaction-completion webhook URL.
5. Test a physical order, a digital order, a failed or abandoned payment, a repeated webhook, and an order containing products from more than one seller. Confirm that inventory and seller notifications update only after Monnify confirms payment.
6. Switch to the live API key, secret and contract code, and set `MONNIFY_BASE_URL=https://api.monnify.com` only after sandbox tests and merchant settlement details have been validated.

## DNS

The Vercel project is already associated with `market.ethandigitalacademy.org`. At Spaceship, create:

- Type: `CNAME`
- Host: `market`
- Target: `d5c56c7f0f32e06b.vercel-dns-017.com`
- TTL: Auto

The custom URL becomes fully active after DNS resolution and Vercel domain status both confirm the change. The generated `*.vercel.app` URL can be used while DNS propagates.

## Local development

```bash
npm install
cp .env.example .env
# Fill in local values; never commit .env
npx vercel dev
```

The schema is initialized by the first successful API request using `CREATE TABLE IF NOT EXISTS` and seed inserts. Use a dedicated development Neon branch when testing schema changes.

## Release notes

- `1.0.0`: multi-vendor storefront, backend API, authentication, seller/admin workflows, product images, order records and Monnify integration.
- `1.1.0`: seller storefront pages, persistent-cart hydration, buyer product reviews, admin seller payout account visibility, current Paystack timestamped webhook signature parsing, security headers and cache rotation.
- `1.1.1`: serialize first-run database schema creation across concurrent serverless cold starts using a PostgreSQL advisory lock.
- `1.2.0`: buyer receipt confirmation, per-item dispute management, seller responses, conditional payout eligibility and crawlable product/store SEO pages with structured data and dynamic sitemaps.
- `1.8.0`: buyer sharing prompts, native/WhatsApp invite sharing, seller store and product marketing links, admin launch-message kit and acquisition cache rotation.

## Operational notes

- No real products are pre-seeded. Sellers create listings and administrators approve them before publication.
- New products are `pending` until reviewed.
- Default marketplace commission is 10%; default physical delivery is ₦2,000. Both values are adjustable by the marketplace administrator.
- Digital products currently use seller-provided HTTPS delivery links, which are displayed in a buyer's account only after payment is verified. Use a secure, access-controlled digital delivery destination.
- This is an operational software foundation, not a substitute for the marketplace's final legal terms, privacy notice, returns/refunds policy, seller agreement or Nigerian tax/compliance review.
