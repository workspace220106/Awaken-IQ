# Awaken-IQ

Marketing site + student/parent portal + management console for Awaken IQ.

- `frontend/` — static HTML (served directly by Vercel). `initial_*.html` are the public marketing pages; the rest are the portal.
- `backend/server.js` — Express API (Vercel serverless function). Firestore for data, Google Drive for files, Razorpay for payments.
- `backend/lib/` — pure modules (pricing, validation) covered by `npm test`.

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
- **Payments** — `POST /api/create-order { programKey, email }`; the server prices the order from `backend/lib/programs.js` and stores it in `orders/`. `POST /api/verify-payment` checks the Razorpay HMAC and marks the order paid. `POST /api/register` only sets `paymentStatus: 'Paid'` when it references a paid, unconsumed order for the same email. UPI/offline payments are confirmed by an admin from the management console ("mark paid").
- **Progress videos** — each student has a Drive folder under `DRIVE_PARENT_FOLDER_ID`, created and shared with the parent on first use (`GET /api/drive-folder`). Parents upload directly to Drive; management opens the folder from the console. To use one shared folder for everyone instead, set `DRIVE_UPLOAD_FALLBACK_LINK` in `frontend/my-courses.html`.
- **DMIT reports** — PDF only, streamed to a `DMIT Reports` Drive folder; the student's record stores the Drive file id and view link.
- **Zoom** — attendance is only recorded for the link currently assigned to the student's group; Web SDK signatures are participant-only and only for that meeting.

## Scripts

| command | what |
| --- | --- |
| `npm start` | run the API |
| `npm run dev` | run with file watching |
| `npm test` | unit tests (`node --test`) |
| `npm run audit` | dependency vulnerability scan |
