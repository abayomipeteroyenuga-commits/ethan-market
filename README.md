# ETHAN MARKET

ETHAN MARKET is a multi-vendor marketplace for physical and digital products, powered by Ethan Digital Academy. It has a public storefront, buyer accounts, seller onboarding and store pages, a seller workspace, a marketplace administration dashboard, order tracking, product moderation, a wishlist, reviews, image uploads, and Paystack integration.

## Stack

- Static storefront: HTML, CSS and browser JavaScript, installable as a PWA
- API: Vercel Functions (Node.js 22+)
- Database: PostgreSQL 17 on a dedicated Neon project
- Public product images: Vercel Blob
- Payments: Paystack initialize, server-side verification and signed webhooks
- Currency: NGN; monetary values are stored as integer kobo

## Main routes

- Storefront: `https://market.ethandigitalacademy.org/`
- Marketplace API: `/api/market`
- Payment webhook: `/api/market-webhook`
- Product image upload: `/api/market-upload`
- Database health check: `/api/market?health=1`

## Features

### Buyers

- Browse approved stores and published products
- Search, category/type filters, sort, product details and seller storefronts
- Persistent shopping bag and wishlist
- Buyer registration/login and order history
- Paystack checkout (once merchant keys are configured)
- Server-side payment verification and webhook fulfilment
- Digital delivery links are shown only in paid order history; physical order tracking is shown in the same area
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

## Payment behaviour

The backend initializes Paystack transactions server-side. It verifies the transaction status, exact amount, currency and reference before setting an order to paid. Webhook events are validated against the raw request body and the current timestamped Paystack signature format, with legacy signature support. Fulfilment and payout-ledger creation are idempotent.

Seller transfers are **not automatically initiated** by this first production release. The dashboard provides a payout ledger: the marketplace administrator approves a seller balance, makes the transfer through the merchant's bank/Paystack operations, then records the cleared transfer reference. Automated Paystack subaccount splits can be enabled as a later phase after the merchant account and seller bank verification process are confirmed.

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
| `PAYSTACK_SECRET_KEY` | Paystack test or live secret key |
| `PAYSTACK_WEBHOOK_SECRET` | Current Paystack webhook signing secret (`whsec_...`) |

Do not commit real secrets or put Paystack secret keys in browser code. See `.env.example` for the variable names only.

## First-time owner activation

1. Open the production storefront and choose **Create account**.
2. Register using the configured owner email.
3. Enter the one-time owner activation code provided separately by the marketplace operator.
4. After the owner account is successfully created, remove `MARKET_OWNER_BOOTSTRAP_TOKEN` from Vercel and redeploy. The database also prevents a second owner activation.

## Paystack setup before live transactions

1. Add the Paystack **test** secret key as `PAYSTACK_SECRET_KEY` in Vercel.
2. Add the webhook signing secret from Paystack Developer settings as `PAYSTACK_WEBHOOK_SECRET`.
3. Register `https://market.ethandigitalacademy.org/api/market-webhook` in the Paystack dashboard.
4. Test a physical order, a digital order, a failed payment, a repeated webhook and an order with more than one seller.
5. Switch to the live secret and webhook keys only after test transactions and merchant settlement details are validated.

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

- `1.0.0`: multi-vendor storefront, backend API, authentication, seller/admin workflows, product images, order records and Paystack integration.
- `1.1.0`: seller storefront pages, persistent-cart hydration, buyer product reviews, admin seller payout account visibility, current Paystack timestamped webhook signature parsing, security headers and cache rotation.

## Operational notes

- No real products are pre-seeded. Sellers create listings and administrators approve them before publication.
- New products are `pending` until reviewed.
- Default marketplace commission is 10%; default physical delivery is ₦2,000. Both values are adjustable by the marketplace administrator.
- Digital products currently use seller-provided HTTPS delivery links, which are displayed in a buyer's account only after payment is verified. Use a secure, access-controlled digital delivery destination.
- This is an operational software foundation, not a substitute for the marketplace's final legal terms, privacy notice, returns/refunds policy, seller agreement or Nigerian tax/compliance review.
