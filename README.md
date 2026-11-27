# PG Manager Backend

Multi-tenant REST API for a PG (paying guest) management product.
Stack: Node.js, TypeScript, Express, Prisma, PostgreSQL, JWT, Zod.

Each PG owner gets an **Organization**. All owners share one database; every
business table has an `organizationId`, and every query filters by the logged-in
user's organization so owners can never see each other's data.

## What's in this first chunk

- Project setup (TypeScript, Express, error handling, validation)
- Database schema: organizations, users, properties, rooms, beds, tenants
- Auth: owner signup (creates organization + owner), login, `me`
- Role guards: `PLATFORM_ADMIN`, `OWNER`, `STAFF`, `TENANT`
- A sample `properties` module that shows the pattern for every future module

## Setup

### 1. Install Node.js
Install the LTS version from https://nodejs.org, then check:

```bash
node -v   # should be v20 or newer
```

### 2. Get a free PostgreSQL database
Create a free project on https://neon.tech (or https://supabase.com) and copy the
connection string. It looks like `postgresql://user:pass@host/dbname?sslmode=require`.

### 3. Install and configure

```bash
cd pg-manager-backend
npm install
cp .env.example .env        # on Windows: copy .env.example .env
```

Open `.env` and set:
- `DATABASE_URL` to your connection string
- `JWT_SECRET` to a long random string. Generate one with:
  `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

### 4. Create the database tables

```bash
npx prisma migrate dev --name init
```

This creates all tables and generates the typed Prisma client.

### 5. Run the server

```bash
npm run dev
```

Open http://localhost:4000/health. You should see `{"status":"ok",...}`.

### 6. (Optional) Create your platform admin account

```bash
SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=choose-a-password npm run seed
```

On Windows PowerShell:

```powershell
$env:SEED_ADMIN_EMAIL="you@example.com"; $env:SEED_ADMIN_PASSWORD="choose-a-password"; npm run seed
```

## Try it

Use Postman, Thunder Client (VS Code), or curl.

**Sign up as a PG owner**

```bash
curl -X POST http://localhost:4000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"organizationName":"Sunrise PG","name":"Ravi","email":"ravi@example.com","password":"password123"}'
```

The response contains a `token`. Send it on later requests as
`Authorization: Bearer <token>`.

**Create a property**

```bash
curl -X POST http://localhost:4000/api/properties \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"name":"Sunrise PG - Block A","addressLine":"12 Main Road","city":"Jammu"}'
```

## API so far

| Method | Path | Who | Purpose |
|--------|------|-----|---------|
| GET | `/health` | public | Server check |
| POST | `/api/auth/signup` | public | Create owner + organization |
| POST | `/api/auth/login` | public | Log in, get token |
| GET | `/api/auth/me` | any logged in | Current user |
| GET | `/api/properties` | owner, staff | List own properties |
| POST | `/api/properties` | owner | Create property |
| GET | `/api/properties/:id` | owner, staff | Property with rooms and beds |
| POST | `/api/rooms` | owner | Create a room and its beds together |
| GET | `/api/rooms` | owner, staff | List rooms (`?propertyId=` `?status=AVAILABLE`) |
| GET | `/api/rooms/:id` | owner, staff | One room with its beds |
| PATCH | `/api/rooms/:id` | owner | Edit room details |
| DELETE | `/api/rooms/:id` | owner | Delete (blocked if occupied or reserved) |
| POST | `/api/beds` | owner | Add a bed to a room |
| GET | `/api/beds` | owner, staff | List beds (`?status=` `?propertyId=`) |
| PATCH | `/api/beds/:id` | owner | Change rent, deposit, label, status |
| DELETE | `/api/beds/:id` | owner | Delete (blocked if occupied or reserved) |
| GET | `/api/occupancy` | owner, staff | Occupied / available counts, overall and per property |
| POST | `/api/tenants` | owner, staff | Create a tenant profile |
| GET | `/api/tenants` | owner, staff | List tenants (`?status=` `?search=`) with current bed |
| GET | `/api/tenants/:id` | owner, staff | Profile + full stay history |
| PATCH | `/api/tenants/:id` | owner, staff | Edit profile / KYC details |
| POST | `/api/stays/check-in` | owner, staff | Put a tenant in a bed (bed becomes OCCUPIED) |
| POST | `/api/stays/:id/notice` | owner, staff | Tenant gives notice; bed shows "available from" |
| POST | `/api/stays/:id/cancel-notice` | owner, staff | Tenant decides to stay |
| POST | `/api/stays/:id/check-out` | owner, staff | Tenant leaves; bed becomes AVAILABLE; deposit recorded |
| GET | `/api/stays` | owner, staff | List stays (`?active=true` `?propertyId=` `?tenantId=`) |
| GET | `/api/stays/:id` | owner, staff | One stay |
| POST | `/api/bills/generate` | owner | Create rent bills for a month: `{"month":"2026-11","dueDay":5}` |
| POST | `/api/bills` | owner | One-off charge (electricity, late fee, other) |
| GET | `/api/bills` | owner, staff | List bills (`?status=` `?month=` `?overdue=true` `?tenantId=` `?propertyId=`) |
| GET | `/api/bills/:id` | owner, staff | Bill with its payments |
| POST | `/api/bills/:id/cancel` | owner | Cancel a bill (only if nothing paid) |
| POST | `/api/bills/:id/reopen` | owner | Undo a cancellation (bill goes back to UNPAID) |
| POST | `/api/bills/:id/payments` | owner, staff | Record a payment (full or partial) |
| GET | `/api/payments` | owner, staff | List payments with total (`?from=` `?to=` `?method=` `?tenantId=`) |
| GET | `/api/payments/:id` | owner, staff | Receipt data |
| GET | `/api/dashboard/owner` | owner, staff | Home-screen numbers (`?month=2026-11`, defaults to this month) |
| POST | `/api/auth/change-password` | any logged in | Change own password |
| POST | `/api/tenants/:id/account` | owner | Create a tenant's login (`{"email":"..."}`; returns a temporary password) |
| POST | `/api/tenants/:id/account/reset-password` | owner | Set a new temporary password for a tenant |
| GET | `/api/me/dashboard` | tenant | Own bed, dues, open bills, recent payments |
| GET | `/api/me/bills` | tenant | Own bills (`?status=PAID`) |
| GET | `/api/me/payments` | tenant | Own payment history |
| GET | `/api/me/payments/:id` | tenant | Own receipt |
| POST | `/api/notifications/bills/:billId` | owner, staff | Email one bill (or overdue reminder) to its tenant |
| POST | `/api/notifications/bills` | owner, staff | Email many: `{"kind":"BILL","month":"2026-11"}` or `{"kind":"REMINDER"}` |
| POST | `/api/notifications/payments/:paymentId/receipt` | owner, staff | Email a receipt |
| GET | `/api/notifications` | owner, staff | Log of what was sent / failed (`?status=FAILED` `?type=` `?tenantId=`) |
| POST | `/api/staff` | owner | Create a staff login (returns a temporary password once) |
| GET | `/api/staff` | owner | List staff |
| PATCH | `/api/staff/:id` | owner | Edit staff, or deactivate with `{"isActive":false}` |
| POST | `/api/staff/:id/reset-password` | owner | New temporary password for staff |
| GET | `/api/automation/settings` | owner | Current automation settings |
| PATCH | `/api/automation/settings` | owner | Switch automation on/off and tune it |
| POST | `/api/automation/run` | owner | Run today's automation for your business now (`{"forceGenerate":true}` to create this month's rent) |
| POST | `/api/expenses` | owner, staff | Record an expense (`category`, `amount`, `expenseDate`) |
| GET | `/api/expenses` | owner, staff | List expenses with totals (`?month=2026-11` `?category=` `?propertyId=`) |
| PATCH | `/api/expenses/:id` | owner | Edit an expense |
| DELETE | `/api/expenses/:id` | owner | Delete an expense |
| GET | `/api/reports/monthly` | owner | Income, expenses, profit, unpaid rent, occupancy (`?month=2026-11`) |
| GET | `/api/reports/trend` | owner | Income / expenses / profit per month for a chart (`?months=6&to=2026-11`) |
| GET | `/api/reports/export` | owner | CSV download (`?type=payments\|expenses\|bills&month=2026-11`) |
| POST | `/api/me/complaints` | tenant | Raise a complaint |
| GET | `/api/me/complaints` | tenant | Own complaints (`?status=`) |
| GET | `/api/me/complaints/:id` | tenant | One complaint with comments |
| POST | `/api/me/complaints/:id/comments` | tenant | Add a comment |
| POST | `/api/me/complaints/:id/reopen` | tenant | Reopen a resolved complaint |
| GET | `/api/complaints` | owner, staff | List with counts per status (`?status=` `?category=` `?priority=` `?tenantId=` `?propertyId=`) |
| GET | `/api/complaints/:id` | owner, staff | Complaint with conversation |
| PATCH | `/api/complaints/:id` | owner, staff | Change status, priority, category, resolution note |
| POST | `/api/complaints/:id/comments` | owner, staff | Reply to the tenant |
| POST | `/api/announcements` | owner | Post a notice (`sendEmail: true` also emails it) |
| GET | `/api/announcements` | owner, staff | List notices (`?active=true`) |
| PATCH | `/api/announcements/:id` | owner | Edit a notice |
| DELETE | `/api/announcements/:id` | owner | Delete a notice |
| POST | `/api/announcements/:id/email` | owner | Email the notice to tenants (`{"resend":true}` to send again) |
| GET | `/api/me/announcements` | tenant | Notices for the tenant (whole PG + own property) |
| GET | `/api/subscription` | owner, staff | Plan status: trial / paid / ended, days left, price, how to pay |
| GET | `/api/admin/organizations` | platform admin | All PG businesses with plan status (`?status=EXPIRED` `?search=`) |
| GET | `/api/admin/organizations/:id` | platform admin | One business with payment history |
| POST | `/api/admin/organizations/:id/subscription/payments` | platform admin | Record a payment from an owner and extend their plan |
| PATCH | `/api/admin/organizations/:id/subscription` | platform admin | Extend the free trial or change the price |

## Staff

Staff log in with the normal `POST /api/auth/login`. A staff member can view data, check tenants in and out, and record payments and send emails. They cannot create properties, rooms, beds or bills, cancel bills, create accounts, or change settings. Deactivating a staff member (`isActive: false`) blocks them immediately, even if they are logged in.

## Automation (the scheduler)

A daily job runs inside the server at **9:00 AM India time** and, for every business that switched things on:

1. **On the 1st of the month:** creates that month's rent bills, then emails them (if `autoSendBills` is on). Tenants already emailed are skipped.
2. **Every day:** emails reminders for overdue bills, at most one per bill every `reminderEveryDays` days (if `autoRemindersEnabled` is on).

Everything is **off by default**. Switch it on with `PATCH /api/automation/settings`, for example:

```json
{ "autoRentEnabled": true, "autoRentDueDay": 5, "autoSendBills": true, "autoRemindersEnabled": true, "reminderEveryDays": 3 }
```

Try it without waiting for 9 AM: `POST /api/automation/run` with `{"forceGenerate": true}`. This does exactly what the daily job does for your business.

Notes:
- The job only runs while the server is running. If the server is off at 9 AM, it is skipped that day (reminders resume the next day; to create a missed month's rent, run `POST /api/automation/run` with `forceGenerate`, or `POST /api/bills/generate`).
- Rent is only created automatically on the 1st, so tenants who check in mid-month are not billed a full month by surprise.
- Change the time with `SCHEDULER_CRON` in `.env`, or turn the job off with `SCHEDULER_ENABLED=false`.
- If you run several copies of the server, turn the scheduler off on all but one.

## Email setup

By default `EMAIL_PROVIDER=console`: emails are **printed in the terminal where the server runs** and not really sent. Use this to test.

To send real emails, edit `.env`:

```
EMAIL_PROVIDER=smtp
EMAIL_FROM="Sunrise PG <you@gmail.com>"
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=your-16-letter-app-password
```

For Gmail you must turn on 2-step verification, then create an **App password** (Google Account > Security > App passwords). Your normal Gmail password will not work. Restart the server after changing `.env`.

Notes:
- Tenants need an email address on their profile to receive anything.
- Bill and reminder emails also list the tenant's **other pending charges** (electricity, extra charges, overdue items, anything else due by the end of that month) with a total outstanding. Charges due in later months are left out. An email is built when it is sent, so a charge added afterwards only shows up in the next email.
- Bulk "BILL" sends skip bills that were already emailed (send `"resend": true` to override).
- Every attempt, successful or not, is saved in the notification log.
- SMS and WhatsApp will plug in the same way later (they need provider accounts and approved message templates).

Tenant login flow:
1. Owner calls `POST /api/tenants/:id/account` and gets a `temporaryPassword` (shown only once).
2. The tenant logs in with the normal `POST /api/auth/login` (email + that password).
3. The tenant calls `/api/me/...` endpoints, and `POST /api/auth/change-password` to set their own password.
4. Tenants cannot use owner endpoints, and owners/staff cannot use `/api/me`.

Dashboard notes:
- `rent.billed / collected / pending` are for bills **due in the chosen month**.
- `rent.receivedInMonth` is cash actually received in that month, including late payments for older bills.
- `overdue` covers unpaid bills past their due date across **all** months, with the top 10 tenants who owe the most.
- "Today" and "this month" follow Indian time (IST).
- Every request now checks that the logged-in account still exists and is active. Tokens of deleted or deactivated accounts get a 401 / 403.

Billing notes:
- Generating rent twice for the same month is safe; it skips stays already billed.
- A cancelled bill is not owed (balance 0) and is not re-billed by *generate*. The response shows `skippedCancelled`; use `reopen` to bring a bill back.
- Rent is billed as the full monthly amount (no part-month proration yet).
- Check-out is refused while the tenant has unpaid bills, unless you send `"confirmOutstandingDues": true`.
- "Overdue" is not stored; it is calculated (not fully paid and past the due date).

### Example: create a room with 2 beds

```bash
curl -X POST http://localhost:4000/api/rooms \
  -H "Content-Type: application/json" -H "Authorization: Bearer <token>" \
  -d '{"propertyId":"<property id>","roomNumber":"101","floor":1,"sharingType":"DOUBLE","monthlyRent":6000,"securityDeposit":6000,"hasAC":true}'
```

Beds are created automatically (1 for SINGLE, 2 for DOUBLE, 3 for TRIPLE, 4 for QUAD).
For a DORMITORY, also send `"bedCount": 8` (or however many beds).

Errors always look like `{ "error": { "message": "...", "details": ... } }`.

## Deploying (Render + Neon)

1. Use a **separate Neon database for production** (create a new project/branch) and copy its pooled connection string.
2. Commit `prisma/migrations` to git. Never commit `.env`.
3. On Render: New > Blueprint, pick the repo (it reads `render.yaml`), then fill in `DATABASE_URL` and `EMAIL_FROM`.
   Every deploy runs `prisma migrate deploy` automatically.
4. Open `https://<your-service>.onrender.com/health` - you should see `{"status":"ok"}`.
5. In Postman set `baseUrl` to the Render URL.
6. Daily job: the free plan sleeps when idle, so the built-in timer is off (`SCHEDULER_ENABLED=false`).
   Create a job on cron-job.org: `POST https://<your-service>.onrender.com/api/internal/run-daily`,
   header `x-cron-secret: <CRON_SECRET from Render>`, every day at 09:00 (Asia/Kolkata).
   It answers `202` at once and works in the background. Running it twice is harmless.

Extra protections: login/signup are limited to 20 tries per IP per 15 minutes, other API calls to 300 per minute.

## Expenses and reports

Owners and staff record expenses (`POST /api/expenses`); only the owner can edit or delete them. The owner-only reports then show:

- **Monthly report:** income is the money actually received in the month (cash basis, even if it paid an older bill). Profit = income - expenses. It also shows bills due that month and how much is still unpaid, plus beds filled on the last day of the month.
- **Trend:** the same numbers for the last N months, oldest first, for a chart.
- **CSV export:** payments, expenses or bills of a month, opens in Excel or Google Sheets.

Months and dates use India time. This chunk adds a table: run `npx prisma migrate dev --name add_expenses` after copying the new `schema.prisma`.

## Complaints and announcements

**Complaints:** a tenant raises one (`POST /api/me/complaints`); the building and room are filled in from their stay. Owner and staff move it through `OPEN` -> `IN_PROGRESS` -> `RESOLVED` -> `CLOSED` and chat with the tenant in the comments. A tenant can reopen a `RESOLVED` complaint. The owner dashboard now shows how many complaints are open or in progress.

**Announcements:** the owner posts a notice for all tenants or one property, can pin it and give it a last day (`expiresOn`). Tenants read them at `GET /api/me/announcements`. `sendEmail: true` (or `POST /api/announcements/:id/email`) also emails it to tenants who are staying now. A notice is not emailed twice unless you send `{"resend": true}`.

This chunk adds tables: run `npx prisma migrate dev --name add_complaints_announcements` after copying the new `schema.prisma`.

## Owner subscription (tenants are always free)

- A new owner gets a **free trial** (`TRIAL_DAYS`, default 30) counted from signup, then pays `SUBSCRIPTION_PRICE` (default 300 rupees) per month. Tenants never pay.
- The plan is worked out from two dates (`trialEndsOn`, `paidUntil`): **TRIALING**, **ACTIVE** (a payment covers today) or **EXPIRED**. Nothing needs to run at midnight.
- When a plan is **EXPIRED**, owners and staff can still log in and view everything, but every change (POST / PATCH / DELETE) answers **402** "Your free trial has ended...". Tenants are not affected, and the daily automation skips that business until it pays.
- `GET /api/subscription` and `GET /api/auth/me` (field `subscription`) tell the app what to show, for example "12 days of free trial left".
- **No payment gateway yet.** Until Razorpay is connected, an owner pays you (UPI, bank...) and you record it with `POST /api/admin/organizations/:id/subscription/payments` using your PLATFORM_ADMIN account. The new period starts the day after what is already covered. One month = 30 days. Put your payment details in `PAYMENT_INSTRUCTIONS` so owners see them.
- Businesses created before this feature get a fresh free trial the first time they are looked up.

This chunk adds tables: run `npx prisma migrate dev --name add_subscriptions` after copying the new `schema.prisma`.

## Project structure

```
prisma/
  schema.prisma        database tables
  seed.ts              creates the platform admin
src/
  server.ts            starts the server
  app.ts               middleware + routes
  config/env.ts        validated environment variables
  lib/                 prisma client, JWT, HttpError
  middleware/          auth, validation, error handling
  modules/
    auth/              signup, login, me
    properties/        sample module (template for the rest)
```

## The one rule for multi-tenancy

In every route that touches business data:

1. Use `authenticate` and `requireRole(...)`.
2. Get the organization with `orgIdOf(req)`.
3. Include `organizationId` in every `where` and in `data` when creating.

See `src/modules/properties/properties.routes.ts` for the pattern.

## Next chunks

1. ~~Rooms and beds (CRUD, occupancy summary)~~ done
2. ~~Tenants and check-in / check-out (stay history, notice period)~~ done
3. ~~Billing and payments (monthly bills, receipts)~~ done
4. ~~Dashboard APIs (occupancy, collection summary)~~ owner dashboard done; tenant dashboard comes with tenant login
5. Notifications: ~~email bills, reminders and receipts~~ done; SMS and WhatsApp later; automatic monthly schedule later
6. ~~Tenant login and tenant dashboard~~ done
7. ~~Staff accounts~~ and ~~automatic monthly scheduler~~ done
8. ~~Expenses, monthly report, CSV export~~ done; hosting is prepared (see Deploying)
9. ~~Complaints and announcements~~ done
10. File uploads (ID proof, photos), SMS / WhatsApp, React Native app
