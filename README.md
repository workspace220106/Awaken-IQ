# Awaken-IQ

Marketing site + student/parent portal + management console for Awaken IQ.

- `frontend/` — static HTML (served directly by Vercel). `initial_*.html` are the public marketing pages; the rest are the portal.
- `backend/server.js` — Express API (Vercel serverless function). Firestore for data, Google Drive for files, Razorpay for payments.
- `backend/lib/` — pure modules (pricing, validation) covered by `npm test`.
- `frontend/assets/css/<page>.css` — **generated** Tailwind output, one file per portal page, committed so Vercel needs no build step. After changing classes in any portal page run `npm run build:css` and commit the result (each page keeps its own colour tokens, which is why there is one file per page).

## Run locally

```bash
npm install
cp .env.example .env   # fill in every value
npm run dev            # http://localhost:8080
```

For local development the two service-account JSON files may sit in `backend/` (they are git-ignored). In production they must be supplied as environment variables — see `.env.example`.

## Deploy (Vercel)

Set every variable from `.env.example` in **Project → Settings → Environment Variables**, then push to `main`. `vercel.json` routes `/api/*` to the function and everything else to `frontend/`.

## How things work

- **Sessions** — one signed, `httpOnly`, `SameSite=Lax` cookie (`session`) carrying `{ uid, role }`. Signed with `SESSION_SECRET`.
- **Student login** — email + bcrypt-hashed password. Accounts created before hashing was introduced are upgraded transparently on their next successful login.
- **Management login** — `ADMIN_USERNAME` / `ADMIN_PASSWORD` via `POST /api/admin/login`. Every `/api/admin/*` route and the attendance routes require the admin role.
- **Payments** — `POST /api/create-order { programKey, email }`; the server prices the order from `backend/lib/programs.js` and stores it in `orders/`. `POST /api/verify-payment` checks the Razorpay HMAC and marks the order paid; the Razorpay **webhook** (`POST /api/razorpay-webhook`, `payment.captured` / `order.paid`) does the same server-to-server so a closed browser can't lose a payment. `POST /api/register` sets `paymentStatus: 'Paid'` when it references a paid, unconsumed order for the same email — or, if no order id is sent, when an unclaimed paid order exists for that email. Paid orders that never became an enrolment show up under **Unclaimed Payments** in the management console, where an admin links them to a student. UPI/offline payments are confirmed with "mark paid".
- **Password reset** — `POST /api/forgot-password` emails a single-use link (`reset-password.html?token=…`, 1-hour expiry, token stored hashed in `passwordResets/`); `POST /api/reset-password` sets the new bcrypt hash. Requires `SMTP_*` env vars; responses never reveal whether an email exists.
- **Progress videos** — each student has a Drive folder under `DRIVE_PARENT_FOLDER_ID`, created and shared with the parent on first use (`GET /api/drive-folder`). Parents upload directly to Drive; management opens the folder from the console. To use one shared folder for everyone instead, set `DRIVE_UPLOAD_FALLBACK_LINK` in `frontend/my-courses.html`.
- **DMIT reports** — PDF only, streamed to a `DMIT Reports` Drive folder; the student's record stores the Drive file id and view link.
- **Rate limiting** — 20 auth attempts / 15 min and 120 API calls / min per IP. With `UPSTASH_REDIS_REST_URL` + `_TOKEN` set the counters are shared across all Vercel instances (sliding window in Upstash Redis); without them the limiter is in-memory per instance. If Redis is unreachable the limiter fails open and logs `Rate limiter error`.
- **CSP** — `vercel.json` sends `Content-Security-Policy-Report-Only`; violations are POSTed to `/api/csp-report` and appear in Vercel logs as `CSP violation …`. Once production logs are clean, rename the header to `Content-Security-Policy` to enforce it.
- **Zoom** — attendance is only recorded for the link currently assigned to the student's group; Web SDK signatures are participant-only and only for that meeting.

## Scripts

| command | what |
| --- | --- |
| `npm start` | run the API |
| `npm run dev` | run with file watching |
| `npm test` | unit tests (`node --test`) |
| `npm run audit` | dependency vulnerability scan |
| `npm run build:css` | rebuild the per-page Tailwind stylesheets |
