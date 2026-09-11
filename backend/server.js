require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { google } = require('googleapis');
const multer = require('multer');
const Razorpay = require('razorpay');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Ratelimit } = require('@upstash/ratelimit');
const { Redis } = require('@upstash/redis');
const nodemailer = require('nodemailer');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const { getProgram, amountInPaise } = require('./lib/programs');
const V = require('./lib/validate');
const { HttpError } = V;

// ---------------------------------------------------------------------------
// Configuration — every secret comes from the environment. No literal fallbacks.
// ---------------------------------------------------------------------------
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
const PORT = process.env.PORT || 8080;

function requireEnv(name) {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required environment variable ${name}. See .env.example.`);
    return value;
}

const SESSION_SECRET = requireEnv('SESSION_SECRET');
const RAZORPAY_KEY_ID = requireEnv('RAZORPAY_KEY_ID');
const RAZORPAY_KEY_SECRET = requireEnv('RAZORPAY_KEY_SECRET');
const ADMIN_USERNAME = requireEnv('ADMIN_USERNAME');
const ADMIN_PASSWORD = requireEnv('ADMIN_PASSWORD');
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
// Public origin used in emails (never derived from the request Host header).
const APP_URL = (process.env.APP_URL
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : `http://localhost:${PORT}`)).replace(/\/$/, '');
const SMTP = {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || process.env.SMTP_USER || ''
};
const ZOOM_SDK_KEY = process.env.ZOOM_SDK_KEY || '';
const ZOOM_SDK_SECRET = process.env.ZOOM_SDK_SECRET || '';
// "AwakenIQ" shared folder: student folders and DMIT reports are created underneath it.
const DRIVE_PARENT_FOLDER_ID = process.env.DRIVE_PARENT_FOLDER_ID || '19SlDbrSRTabzTe9uAfnkLbqZdaIwZq-Z';

// Credentials JSON: env var in production; a git-ignored local file is allowed for development only.
function loadCredentialJson(envName, localFileName) {
    if (process.env[envName]) return JSON.parse(process.env[envName]);
    const localPath = path.join(__dirname, localFileName);
    if (!IS_PROD && fs.existsSync(localPath)) {
        console.warn(`[dev] Loading ${envName} from local file ${localFileName}`);
        return JSON.parse(fs.readFileSync(localPath, 'utf8'));
    }
    throw new Error(`Missing required environment variable ${envName}.`);
}

const serviceAccount = loadCredentialJson('FIREBASE_SERVICE_ACCOUNT', 'awakeniq-2d15a-firebase-adminsdk-fbsvc-7d8e904cd1.json');
const driveCredentials = loadCredentialJson('GOOGLE_DRIVE_CREDENTIALS', 'awakeniq-ccf56bc780a0.json');

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const usersCol = db.collection('users');
const ordersCol = db.collection('orders');
const groupsCol = db.collection('groups');
const feedbacksCol = db.collection('feedbacks');
const attendanceCol = db.collection('attendance');
const passwordResetsCol = db.collection('passwordResets');

const mailer = SMTP.host && SMTP.user && SMTP.pass
    ? nodemailer.createTransport({ host: SMTP.host, port: SMTP.port, secure: SMTP.port === 465, auth: { user: SMTP.user, pass: SMTP.pass } })
    : null;
if (!mailer) console.warn('SMTP_* not set: password reset emails are disabled.');

const razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });

const drive = google.drive({
    version: 'v3',
    auth: new google.auth.GoogleAuth({
        credentials: driveCredentials,
        scopes: ['https://www.googleapis.com/auth/drive']
    })
});

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1); // Vercel / reverse proxy: needed for correct client IPs in rate limiting
app.disable('x-powered-by');

app.use(helmet({ contentSecurityPolicy: false })); // CSP is set per-route in vercel.json; API responses are JSON

// Razorpay webhook: signature is computed over the raw body, so this route is mounted before the JSON parser.
app.post('/api/razorpay-webhook', express.raw({ type: '*/*', limit: '200kb' }), (req, res, next) => {
    handleRazorpayWebhook(req, res).catch(next);
});

// CSP violation reports (policy is Report-Only until it is proven clean in production).
app.post('/api/csp-report', express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '20kb' }), (req, res) => {
    const r = (req.body && (req.body['csp-report'] || req.body)) || {};
    const pick = (o) => ({
        doc: o['document-uri'] || o.documentURL, directive: o['effective-directive'] || o.effectiveDirective || o['violated-directive'],
        blocked: o['blocked-uri'] || o.blockedURL, line: o['line-number'] || o.lineNumber
    });
    const items = Array.isArray(r) ? r.map((x) => pick(x.body || x)) : [pick(r)];
    for (const i of items) if (i.directive || i.blocked) console.warn('CSP violation', JSON.stringify(i));
    res.status(204).end();
});

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(cookieParser(SESSION_SECRET));

// Rate limiting. On Vercel each function instance has its own memory, so an in-memory
// limiter only counts per instance. When Upstash Redis is configured (UPSTASH_REDIS_REST_URL /
// _TOKEN, or the KV_REST_API_* names the Vercel marketplace integration injects), counts are
// shared across every instance and region. Without it we fall back to the in-memory limiter.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const redis = REDIS_URL && REDIS_TOKEN ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN }) : null;
console.log(redis ? 'Rate limiting: shared (Upstash Redis)' : 'Rate limiting: in-memory (per instance) — set UPSTASH_REDIS_REST_URL/TOKEN for shared limits');

function makeLimiter({ name, windowMs, limit, message }) {
    if (!redis) {
        return rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: message } });
    }
    const rl = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(limit, `${Math.round(windowMs / 1000)} s`),
        prefix: `rl:${name}`,
        analytics: false
    });
    return async (req, res, next) => {
        try {
            const key = req.ip || req.socket.remoteAddress || 'unknown';
            const r = await rl.limit(key);
            res.set('RateLimit-Limit', String(r.limit));
            res.set('RateLimit-Remaining', String(Math.max(0, r.remaining)));
            res.set('RateLimit-Reset', String(Math.max(0, Math.ceil((r.reset - Date.now()) / 1000))));
            if (!r.success) {
                res.set('Retry-After', String(Math.max(1, Math.ceil((r.reset - Date.now()) / 1000))));
                return res.status(429).json({ error: message });
            }
            next();
        } catch (err) {
            // Redis unreachable: fail open rather than lock everyone out, but say so in the logs.
            console.error('Rate limiter error (failing open):', err.message);
            next();
        }
    };
}

const authLimiter = makeLimiter({ name: 'auth', windowMs: 15 * 60 * 1000, limit: 20, message: 'Too many attempts. Please try again in 15 minutes.' });
const apiLimiter = makeLimiter({ name: 'api', windowMs: 60 * 1000, limit: 120, message: 'Too many requests. Please slow down.' });
app.use('/api/', apiLimiter);

// ---------------------------------------------------------------------------
// Sessions — one signed, httpOnly cookie carrying { uid, role }
// ---------------------------------------------------------------------------
const SESSION_COOKIE = 'session';
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REMEMBER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function setSession(res, payload, { remember = false } = {}) {
    res.cookie(SESSION_COOKIE, payload, {
        signed: true,
        httpOnly: true,
        sameSite: 'lax',
        secure: IS_PROD,
        maxAge: remember ? REMEMBER_MAX_AGE_MS : SESSION_MAX_AGE_MS,
        path: '/'
    });
}

function clearSession(res) {
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: IS_PROD, path: '/' });
}

function readSession(req) {
    const s = req.signedCookies[SESSION_COOKIE];
    if (!s || typeof s !== 'object' || typeof s.role !== 'string') return null;
    return s;
}

// Loads the logged-in parent/student and attaches it as req.user.
async function requireUser(req, res, next) {
    try {
        const session = readSession(req);
        if (!session || session.role !== 'user' || !session.uid) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        const snap = await usersCol.doc(session.uid).get();
        if (!snap.exists) {
            clearSession(res);
            return res.status(401).json({ error: 'User not found' });
        }
        req.user = snap.data();
        req.userRef = snap.ref;
        next();
    } catch (err) {
        next(err);
    }
}

function requireAdmin(req, res, next) {
    const session = readSession(req);
    if (!session || session.role !== 'admin') {
        return res.status(401).json({ error: 'Admin authentication required' });
    }
    next();
}

function safeEqual(a, b) {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

// Strip credentials before sending a user document to the client.
function publicUser(user) {
    const { password, passwordHash, driveFolderId, ...rest } = user;
    return rest;
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// Firestore helpers
// ---------------------------------------------------------------------------
async function getUserByEmail(emailAddr) {
    const snap = await usersCol.where('parentEmail', '==', emailAddr).limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
}

async function getUserGroup(uid) {
    const snap = await groupsCol.where('studentIds', 'array-contains', uid).limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
}

// ---------------------------------------------------------------------------
// Google Drive helpers
// ---------------------------------------------------------------------------
function escapeDriveQuery(s) {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findFolderByName(name, parentId) {
    const res = await drive.files.list({
        q: `mimeType='application/vnd.google-apps.folder' and name='${escapeDriveQuery(name)}' and '${parentId}' in parents and trashed = false`,
        fields: 'files(id, name, webViewLink)',
        spaces: 'drive'
    });
    return res.data.files && res.data.files[0] ? res.data.files[0] : null;
}

async function createFolder(name, parentId) {
    const res = await drive.files.create({
        requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
        fields: 'id, webViewLink'
    });
    return res.data;
}

async function getFolderLink(folderId) {
    const res = await drive.files.get({ fileId: folderId, fields: 'id, webViewLink, trashed' });
    return res.data.trashed ? null : res.data.webViewLink;
}

// Returns { id, link } for the student's personal upload folder, creating it and
// sharing it with the parent on first use. The folder id is cached on the user doc.
async function ensureStudentDriveFolder(user, userRef) {
    if (user.driveFolderId) {
        const link = await getFolderLink(user.driveFolderId).catch(() => null);
        if (link) return { id: user.driveFolderId, link };
    }

    const folderName = user.studentName || `Student ${user.id}`;
    let folder = await findFolderByName(folderName, DRIVE_PARENT_FOLDER_ID);
    if (!folder) folder = await createFolder(folderName, DRIVE_PARENT_FOLDER_ID);

    // Give the parent edit access so they can drop videos into the folder.
    try {
        await drive.permissions.create({
            fileId: folder.id,
            requestBody: { role: 'writer', type: 'user', emailAddress: user.parentEmail },
            sendNotificationEmail: false
        });
    } catch (err) {
        // Parent email is not a Google account: fall back to link-based edit access.
        console.warn('Could not share Drive folder with parent email, using link sharing:', err.message);
        await drive.permissions.create({
            fileId: folder.id,
            requestBody: { role: 'writer', type: 'anyone' }
        });
    }

    const link = folder.webViewLink || (await getFolderLink(folder.id));
    await userRef.update({ driveFolderId: folder.id, driveFolderLink: link });
    return { id: folder.id, link };
}

async function ensureReportsFolder() {
    const name = 'DMIT Reports';
    const existing = await findFolderByName(name, DRIVE_PARENT_FOLDER_ID);
    if (existing) return existing.id;
    return (await createFolder(name, DRIVE_PARENT_FOLDER_ID)).id;
}

// Only PDFs, held in memory and streamed to Drive — no local filesystem writes.
const pdfUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        const isPdf = file.mimetype === 'application/pdf' && path.extname(file.originalname).toLowerCase() === '.pdf';
        cb(isPdf ? null : new HttpError(400, 'Only PDF files are accepted.'), isPdf);
    }
});

// ---------------------------------------------------------------------------
// Auth: student / parent
// ---------------------------------------------------------------------------
app.get('/api/session', requireUser, wrap(async (req, res) => {
    const group = await getUserGroup(req.user.id).catch((err) => {
        console.error('Error fetching user group:', err);
        return null;
    });
    res.json({ user: publicUser(req.user), group });
}));

app.post('/api/register', authLimiter, wrap(async (req, res) => {
    const { studentInfo = {}, parentInfo = {}, courseInfo = {}, paymentInfo = {} } = req.body || {};

    const parentEmail = V.email(parentInfo.email);
    const plainPassword = V.password(req.body.password);

    // Payment: only a server-verified, unconsumed order for this email counts as "Paid".
    let order = null;
    if (paymentInfo && paymentInfo.orderId) {
        const orderId = V.str(paymentInfo.orderId, { name: 'Order ID', max: 64, required: true, pattern: /^order_[A-Za-z0-9]+$/ });
        const orderSnap = await ordersCol.doc(orderId).get();
        if (!orderSnap.exists) throw new HttpError(400, 'Payment order not found.');
        order = orderSnap.data();
        if (order.status !== 'paid') throw new HttpError(400, 'Payment for this order has not been verified.');
        if (order.email !== parentEmail) throw new HttpError(400, 'Payment order does not belong to this email.');
    } else {
        // The browser may have lost the order id (closed tab, retry). If this email already
        // has a paid order nobody has claimed, attach it so the parent is not charged twice.
        order = await findUnclaimedPaidOrder(parentEmail);
    }

    const programKey = order ? order.programKey : courseInfo.key;
    const program = getProgram(programKey);

    const newUser = {
        id: crypto.randomUUID(),
        studentName: V.str(studentInfo.fullName, { name: 'Student name', max: 100, required: true }),
        studentAge: V.str(studentInfo.age, { name: 'Age', max: 3 }),
        studentGender: V.str(studentInfo.gender, { name: 'Gender', max: 30 }),
        studentGrade: V.str(studentInfo.grade, { name: 'Grade', max: 30 }),
        studentSchool: V.str(studentInfo.schoolName, { name: 'School', max: 150 }),
        studentSpecialNeeds: V.bool(studentInfo.specialNeeds),
        studentSpecialDetails: V.str(studentInfo.specialDetails, { name: 'Special needs details', max: 1000 }),

        parentName: V.str(parentInfo.parent_name, { name: 'Parent name', max: 100, required: true }),
        parentRelationship: V.str(parentInfo.relationship, { name: 'Relationship', max: 30 }),
        parentMobile: V.str(parentInfo.mobile, { name: 'Mobile', max: 20, pattern: /^[0-9+\-\s()]*$/ }),
        parentAltMobile: V.str(parentInfo.alt_mobile, { name: 'Alternate mobile', max: 20, pattern: /^[0-9+\-\s()]*$/ }),
        parentEmail,
        parentAddress: V.str(parentInfo.address, { name: 'Address', max: 300 }),
        parentCity: V.str(parentInfo.city, { name: 'City', max: 100 }),
        parentState: V.str(parentInfo.state, { name: 'State', max: 100 }),
        parentPincode: V.str(parentInfo.pincode, { name: 'Pincode', max: 10 }),

        enrolledProgram: program ? program.name : 'None Selected',
        duration: program ? program.duration : '',
        paymentStatus: order ? 'Paid' : 'Pending',
        paymentMethod: order ? 'Razorpay' : 'Not paid',
        paymentId: order ? order.paymentId : null,
        orderId: order ? order.id : null,

        passwordHash: await bcrypt.hash(plainPassword, 12),
        registrationDate: new Date().toISOString()
    };

    // Transaction: uniqueness of email + single use of the order, atomically.
    await db.runTransaction(async (tx) => {
        const existing = await tx.get(usersCol.where('parentEmail', '==', parentEmail).limit(1));
        if (!existing.empty) throw new HttpError(409, 'Email already registered.');
        if (order) {
            const fresh = await tx.get(ordersCol.doc(order.id));
            if (!fresh.exists || fresh.data().status !== 'paid') throw new HttpError(400, 'Payment order already used.');
            tx.update(ordersCol.doc(order.id), { status: 'consumed', userId: newUser.id, consumedAt: new Date().toISOString() });
        }
        tx.set(usersCol.doc(newUser.id), newUser);
    });

    setSession(res, { uid: newUser.id, role: 'user' });
    res.status(201).json({ message: 'Registration successful', userId: newUser.id });
}));

app.post('/api/login', authLimiter, wrap(async (req, res) => {
    const emailAddr = V.email(req.body && req.body.email);
    const plainPassword = typeof req.body.password === 'string' ? req.body.password : '';
    if (!plainPassword) throw new HttpError(400, 'Email and password are required.');

    const user = await getUserByEmail(emailAddr) || await getUserByEmail(req.body.email); // legacy rows may be mixed-case
    const invalid = () => res.status(401).json({ error: 'Invalid email or password.' });
    if (!user) return invalid();

    let ok = false;
    if (user.passwordHash) {
        ok = await bcrypt.compare(plainPassword, user.passwordHash);
    } else if (typeof user.password === 'string') {
        // Legacy plaintext row. These passwords were exposed in old git history, so once email
        // reset is available the account must be reset instead of logged into. Until SMTP is
        // configured, verify once and upgrade to a hash so nobody is locked out.
        if (mailer) {
            return res.status(403).json({
                error: 'For your security, please set a new password before logging in. Use "Forgot Password" to receive a reset link.',
                code: 'PASSWORD_RESET_REQUIRED'
            });
        }
        ok = safeEqual(user.password, plainPassword);
        if (ok) {
            await usersCol.doc(user.id).update({
                passwordHash: await bcrypt.hash(plainPassword, 12),
                password: FieldValue.delete()
            });
        }
    }
    if (!ok) return invalid();

    setSession(res, { uid: user.id, role: 'user' }, { remember: V.bool(req.body.remember) });
    res.json({ message: 'Login successful', userId: user.id });
}));

// ---------------------------------------------------------------------------
// Password reset — token is random, stored hashed, single-use, expires in 1 hour.
// Responses never reveal whether an email is registered.
// ---------------------------------------------------------------------------
const RESET_TTL_MS = 60 * 60 * 1000;
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

app.post('/api/forgot-password', authLimiter, wrap(async (req, res) => {
    const emailAddr = V.email(req.body && req.body.email);
    const generic = { message: 'If that email is registered, a reset link has been sent.' };
    if (!mailer) throw new HttpError(503, 'Password reset by email is not configured. Please contact Awaken IQ support.');

    const user = await getUserByEmail(emailAddr) || await getUserByEmail(req.body.email);
    if (!user) return res.json(generic);

    const token = crypto.randomBytes(32).toString('base64url');
    await passwordResetsCol.doc(hashToken(token)).set({
        uid: user.id,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + RESET_TTL_MS).toISOString(),
        used: false
    });

    const link = `${APP_URL}/reset-password.html?token=${token}`;
    await mailer.sendMail({
        from: SMTP.from,
        to: user.parentEmail,
        subject: 'Reset your Awaken IQ portal password',
        text: `Hello ${user.parentName || ''},\n\nWe received a request to reset the password for the Awaken IQ student portal.\n\nReset it here (valid for 1 hour):\n${link}\n\nIf you did not request this, you can ignore this email.\n\n— Awaken IQ`,
        html: `<p>Hello ${escapeHtml(user.parentName || '')},</p>
<p>We received a request to reset the password for the Awaken IQ student portal.</p>
<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#1E4D3B;color:#fff;border-radius:999px;text-decoration:none;font-weight:bold">Reset my password</a></p>
<p style="color:#555;font-size:13px">This link is valid for 1 hour. If you did not request this, you can ignore this email.</p>
<p>— Awaken IQ</p>`
    });
    res.json(generic);
}));

app.post('/api/reset-password', authLimiter, wrap(async (req, res) => {
    const token = V.str(req.body && req.body.token, { name: 'Token', max: 128, required: true, pattern: /^[A-Za-z0-9_-]+$/ });
    const plainPassword = V.password(req.body && req.body.password);
    const ref = passwordResetsCol.doc(hashToken(token));

    const uid = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const r = snap.exists ? snap.data() : null;
        if (!r || r.used || new Date(r.expiresAt).getTime() < Date.now()) {
            throw new HttpError(400, 'This reset link is invalid or has expired. Please request a new one.');
        }
        tx.update(ref, { used: true, usedAt: new Date().toISOString() });
        return r.uid;
    });

    await usersCol.doc(uid).update({
        passwordHash: await bcrypt.hash(plainPassword, 12),
        password: FieldValue.delete(),
        passwordChangedAt: new Date().toISOString()
    });
    clearSession(res);
    res.json({ message: 'Password updated. You can now log in.' });
}));

function escapeHtml(v) {
    return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

app.post('/api/logout', (req, res) => {
    clearSession(res);
    res.json({ message: 'Logout successful' });
});

// ---------------------------------------------------------------------------
// Auth: management
// ---------------------------------------------------------------------------
app.post('/api/admin/login', authLimiter, (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Username and password are required.' });
    }
    const userOk = safeEqual(username, ADMIN_USERNAME);
    const passOk = safeEqual(password, ADMIN_PASSWORD);
    if (!userOk || !passOk) {
        return res.status(401).json({ error: 'Invalid management credentials.' });
    }
    setSession(res, { role: 'admin' });
    res.json({ message: 'Admin login successful' });
});

app.get('/api/admin/session', requireAdmin, (req, res) => {
    res.json({ role: 'admin' });
});

// ---------------------------------------------------------------------------
// Student: Drive upload folder, feedback, class attendance
// ---------------------------------------------------------------------------
app.get('/api/drive-folder', requireUser, wrap(async (req, res) => {
    const folder = await ensureStudentDriveFolder(req.user, req.userRef);
    res.json({ link: folder.link });
}));

app.post('/api/feedback', requireUser, wrap(async (req, res) => {
    const b = req.body || {};
    const rating = V.intInRange(b.academicPerformanceRating, { name: 'Academic performance rating', min: 1, max: 5 });
    const user = req.user;

    const feedbackEntry = {
        id: crypto.randomUUID(),
        studentId: user.id,
        studentName: user.studentName || 'Unknown Student',
        parentEmail: user.parentEmail,
        parentName: user.parentName || 'Unknown Parent',
        enrolledProgram: user.enrolledProgram || 'None Selected',
        academicPerformanceRating: rating,
        comments: V.str(b.comments, { name: 'Comments', max: 2000 }),
        focus_concentration: V.str(b.focus_concentration, { name: 'Focus', max: 1000 }),
        creativity_imagination: V.str(b.creativity_imagination, { name: 'Creativity', max: 1000 }),
        intuition: V.str(b.intuition, { name: 'Intuition', max: 1000 }),
        immunity_health: V.str(b.immunity_health, { name: 'Immunity', max: 1000 }),
        social_confidence: V.str(b.social_confidence, { name: 'Social confidence', max: 1000 }),
        year: V.str(b.year, { name: 'Year', max: 20 }),
        term: V.str(b.term, { name: 'Term', max: 40 }),
        submittedAt: new Date().toISOString()
    };

    await feedbacksCol.doc(feedbackEntry.id).set(feedbackEntry);
    res.status(201).json({ message: 'Feedback submitted successfully', feedback: feedbackEntry });
}));

// Attendance is only recorded for the Zoom link currently assigned to the student's group.
app.post('/api/attend-class', requireUser, wrap(async (req, res) => {
    const zoomLink = V.optionalUrl(req.body && req.body.zoomLink, 'Zoom link');
    if (!zoomLink) throw new HttpError(400, 'zoomLink is required');

    const group = await getUserGroup(req.user.id);
    let assignedLink = '';
    try { assignedLink = group && group.zoomLink ? V.optionalUrl(group.zoomLink) : ''; } catch { assignedLink = ''; }
    if (!assignedLink || assignedLink !== zoomLink) {
        throw new HttpError(403, 'This link is not the live class assigned to your group.');
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const already = (req.user.attendedMeetings || []).some((m) => m.zoomLink === zoomLink && m.date === todayStr);
    if (!already) {
        await req.userRef.update({
            attendedMeetings: FieldValue.arrayUnion({ zoomLink, date: todayStr, timestamp: new Date().toISOString() })
        });
    }
    const fresh = (await req.userRef.get()).data();
    res.json({ message: 'Attendance recorded successfully', attendedMeetings: fresh.attendedMeetings || [] });
}));

// A student's own attendance history, derived from management logs.
app.get('/api/my-attendance', requireUser, wrap(async (req, res) => {
    const snap = await attendanceCol.get();
    const me = req.user;
    const name = (me.studentName || '').toLowerCase();
    const sessions = [];
    snap.forEach((doc) => {
        const s = doc.data();
        // Match by id. Rows saved before ids were recorded fall back to name, but only if
        // exactly one record in that session carries the name (duplicate names are common).
        let record = (s.records || []).find((r) => r && r.studentId === me.id);
        if (!record && name) {
            const byName = (s.records || []).filter((r) => r && !r.studentId && r.name && String(r.name).toLowerCase() === name);
            if (byName.length === 1) record = byName[0];
        }
        if (record) sessions.push({ date: s.date, savedAt: s.savedAt, present: !!record.present });
    });
    sessions.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
    res.json({ sessions });
}));

// Zoom Web SDK signature — always participant role, only for the meeting assigned to the caller's group.
app.post('/api/zoom-signature', requireUser, wrap(async (req, res) => {
    if (!ZOOM_SDK_KEY || !ZOOM_SDK_SECRET) throw new HttpError(503, 'Embedded Zoom is not configured.');

    const requested = V.str(req.body && req.body.meetingNumber, { name: 'meetingNumber', max: 12, required: true, pattern: /^\d{9,12}$/ });
    const group = await getUserGroup(req.user.id);
    const assigned = group ? V.zoomMeetingNumber(group.zoomLink) : null;
    if (!assigned || assigned !== requested) throw new HttpError(403, 'This meeting is not assigned to your group.');

    const iat = Math.round(Date.now() / 1000) - 30;
    const exp = iat + 60 * 60 * 2;
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        sdkKey: ZOOM_SDK_KEY, appKey: ZOOM_SDK_KEY, mn: requested, role: 0, iat, exp, tokenExp: exp
    })).toString('base64url');
    const signature = crypto.createHmac('sha256', ZOOM_SDK_SECRET).update(`${header}.${payload}`).digest('base64url');
    res.json({ signature: `${header}.${payload}.${signature}`, sdkKey: ZOOM_SDK_KEY });
}));

// ---------------------------------------------------------------------------
// Payments (Razorpay) — the server decides the amount and remembers every order.
// ---------------------------------------------------------------------------
app.post('/api/create-order', authLimiter, wrap(async (req, res) => {
    const programKey = V.str(req.body && req.body.programKey, { name: 'Program', max: 30, required: true });
    const emailAddr = V.email(req.body && req.body.email);
    const program = getProgram(programKey);
    if (!program) throw new HttpError(400, 'Unknown program.');

    const amount = amountInPaise(programKey);
    const order = await razorpay.orders.create({
        amount,
        currency: 'INR',
        receipt: `rcpt_${Date.now()}`,
        notes: { programKey: programKey.toLowerCase(), email: emailAddr }
    });

    await ordersCol.doc(order.id).set({
        id: order.id,
        amount,
        currency: 'INR',
        programKey: programKey.toLowerCase(),
        programName: program.name,
        email: emailAddr,
        status: 'created',
        createdAt: new Date().toISOString()
    });

    res.json({ order_id: order.id, amount, currency: 'INR', key_id: RAZORPAY_KEY_ID });
}));

app.post('/api/verify-payment', wrap(async (req, res) => {
    const b = req.body || {};
    const orderId = V.str(b.razorpay_order_id, { name: 'Order ID', max: 64, required: true, pattern: /^order_[A-Za-z0-9]+$/ });
    const paymentId = V.str(b.razorpay_payment_id, { name: 'Payment ID', max: 64, required: true, pattern: /^pay_[A-Za-z0-9]+$/ });
    const signature = V.str(b.razorpay_signature, { name: 'Signature', max: 128, required: true, pattern: /^[a-f0-9]{64}$/ });

    const expected = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
    if (!safeEqual(expected, signature)) {
        console.error('Razorpay signature mismatch for', orderId);
        throw new HttpError(400, 'Signature verification failed.');
    }

    if (!(await ordersCol.doc(orderId).get()).exists) throw new HttpError(400, 'Unknown order.');
    await markOrderPaid(orderId, paymentId, 'checkout');
    res.json({ status: 'ok', message: 'Payment verified successfully.' });
}));

async function findUnclaimedPaidOrder(emailAddr) {
    const snap = await ordersCol.where('email', '==', emailAddr).where('status', '==', 'paid').limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
}

// Marks an order paid from a trusted source (signature-verified checkout or webhook).
async function markOrderPaid(orderId, paymentId, source, extra = {}) {
    const ref = ordersCol.doc(orderId);
    const snap = await ref.get();
    if (!snap.exists) {
        // Order created outside this app (e.g. Razorpay dashboard / payment link): keep a record so it can be reconciled.
        await ref.set({
            id: orderId, status: 'paid', paymentId, paidVia: source, ...extra,
            programKey: extra.programKey || null, email: extra.email || null,
            createdAt: new Date().toISOString(), paidAt: new Date().toISOString()
        });
        return;
    }
    if (snap.data().status === 'created') {
        await ref.update({ status: 'paid', paymentId, paidAt: new Date().toISOString(), paidVia: source });
    }
}

// Razorpay calls this server-to-server on payment events, independent of the parent's browser.
// Configure in Razorpay Dashboard -> Webhooks with events payment.captured and order.paid.
async function handleRazorpayWebhook(req, res) {
    if (!RAZORPAY_WEBHOOK_SECRET) return res.status(503).json({ error: 'Webhook not configured' });
    const signature = req.get('x-razorpay-signature') || '';
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const expected = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    if (!/^[a-f0-9]{64}$/.test(signature) || !safeEqual(expected, signature)) {
        console.error('Razorpay webhook signature mismatch');
        return res.status(400).json({ error: 'Invalid signature' });
    }

    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'Malformed payload' }); }

    const payment = event.payload && event.payload.payment && event.payload.payment.entity;
    if ((event.event === 'payment.captured' || event.event === 'order.paid') && payment && payment.order_id && payment.id) {
        const notes = payment.notes || {};
        await markOrderPaid(payment.order_id, payment.id, 'webhook', {
            email: typeof notes.email === 'string' ? notes.email.toLowerCase() : (payment.email ? String(payment.email).toLowerCase() : null),
            programKey: typeof notes.programKey === 'string' ? notes.programKey : null,
            amount: payment.amount, currency: payment.currency, method: payment.method || null
        });
    }
    // Always 200 so Razorpay does not retry events we intentionally ignore.
    res.json({ received: true });
}

// ---------------------------------------------------------------------------
// Management console
// ---------------------------------------------------------------------------

// Paid orders that never turned into an enrolment (parent paid, registration failed / abandoned).
app.get('/api/admin/orders/unclaimed', requireAdmin, wrap(async (req, res) => {
    const snap = await ordersCol.where('status', '==', 'paid').get();
    const orders = [];
    snap.forEach((doc) => {
        const o = doc.data();
        const program = getProgram(o.programKey);
        orders.push({
            id: o.id, email: o.email, programKey: o.programKey, programName: o.programName || (program ? program.name : null),
            amount: o.amount, paymentId: o.paymentId, paidAt: o.paidAt, paidVia: o.paidVia || 'checkout'
        });
    });
    orders.sort((a, b) => new Date(b.paidAt || 0) - new Date(a.paidAt || 0));
    res.json({ orders });
}));

// Attach an unclaimed paid order to an existing student account.
app.post('/api/admin/orders/:id/assign', requireAdmin, wrap(async (req, res) => {
    const orderId = V.str(req.params.id, { name: 'Order ID', max: 64, required: true, pattern: /^order_[A-Za-z0-9]+$/ });
    const studentId = V.idString(req.body && req.body.studentId, 'Student ID');
    const orderRef = ordersCol.doc(orderId);
    const userRef = usersCol.doc(studentId);

    await db.runTransaction(async (tx) => {
        const [orderSnap, userSnap] = await Promise.all([tx.get(orderRef), tx.get(userRef)]);
        if (!orderSnap.exists || orderSnap.data().status !== 'paid') throw new HttpError(400, 'Order is not an unclaimed paid order.');
        if (!userSnap.exists) throw new HttpError(404, 'Student not found.');
        const order = orderSnap.data();
        const program = getProgram(order.programKey);
        const userUpdate = {
            paymentStatus: 'Paid', paymentMethod: 'Razorpay', paymentId: order.paymentId || null, orderId,
            paymentUpdatedAt: new Date().toISOString()
        };
        if (program) { userUpdate.enrolledProgram = program.name; userUpdate.duration = program.duration; }
        tx.update(userRef, userUpdate);
        tx.update(orderRef, { status: 'consumed', userId: studentId, consumedAt: new Date().toISOString(), consumedBy: 'admin' });
    });
    res.json({ message: 'Order assigned to student' });
}));
app.get('/api/admin/students', requireAdmin, wrap(async (req, res) => {
    const snap = await usersCol.get();
    const students = [];
    snap.forEach((doc) => {
        const u = doc.data();
        students.push({
            id: u.id,
            name: u.studentName || 'Unknown Student',
            level: u.enrolledProgram || 'Level 1 Beginner',
            parentEmail: u.parentEmail,
            paymentStatus: u.paymentStatus || 'Pending'
        });
    });
    res.json({ students });
}));

// Manually mark a student paid (for UPI / offline payments).
app.post('/api/admin/students/:id/payment-status', requireAdmin, wrap(async (req, res) => {
    const id = V.idString(req.params.id, 'Student ID');
    const status = V.str(req.body && req.body.status, { name: 'Status', max: 20, required: true });
    if (!['Paid', 'Pending'].includes(status)) throw new HttpError(400, 'Status must be Paid or Pending.');
    const method = V.str(req.body && req.body.method, { name: 'Method', max: 50 }) || 'Manual';
    const ref = usersCol.doc(id);
    if (!(await ref.get()).exists) throw new HttpError(404, 'Student not found.');
    await ref.update({ paymentStatus: status, paymentMethod: method, paymentUpdatedAt: new Date().toISOString() });
    res.json({ message: 'Payment status updated' });
}));

app.post('/api/attendance', requireAdmin, wrap(async (req, res) => {
    const { date, records } = req.body || {};
    if (!Array.isArray(records) || records.length > 500) throw new HttpError(400, 'Records are required');
    const cleaned = records.map((r) => ({
        studentId: V.idString(r && r.studentId, 'Student ID'),
        name: V.str(r && r.name, { name: 'Name', max: 100 }),
        present: V.bool(r && r.present),
        joinedAt: V.str(r && r.joinedAt, { name: 'Joined at', max: 30 }),
        leftAt: V.str(r && r.leftAt, { name: 'Left at', max: 30 }),
        attendedDuration: V.str(r && r.attendedDuration, { name: 'Duration', max: 30 })
    }));
    const entry = {
        id: crypto.randomUUID(),
        date: V.str(date, { name: 'Date', max: 40 }) || new Date().toISOString(),
        records: cleaned,
        savedAt: new Date().toISOString()
    };
    await attendanceCol.doc(entry.id).set(entry);
    res.json({ message: 'Attendance saved successfully', entry });
}));

app.get('/api/attendance', requireAdmin, wrap(async (req, res) => {
    const snap = await attendanceCol.get();
    const attendance = [];
    snap.forEach((doc) => attendance.push(doc.data()));
    res.json({ attendance });
}));

app.get('/api/admin/feedbacks', requireAdmin, wrap(async (req, res) => {
    const snap = await feedbacksCol.get();
    const feedbacks = [];
    snap.forEach((doc) => feedbacks.push(doc.data()));
    feedbacks.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    res.json({ feedbacks });
}));

// Student progress: each student's Drive folder, plus any legacy videos still stored on user docs.
app.get('/api/admin/improvements', requireAdmin, wrap(async (req, res) => {
    const snap = await usersCol.get();
    const folders = [];
    const videos = [];
    snap.forEach((doc) => {
        const u = doc.data();
        if (u.driveFolderLink) {
            folders.push({ studentName: u.studentName, programName: u.enrolledProgram, link: u.driveFolderLink });
        }
        (u.videos || []).forEach((vid) => videos.push({
            studentName: u.studentName, programName: u.enrolledProgram,
            videoTitle: vid.title, videoUrl: vid.url, addedAt: vid.addedAt
        }));
    });
    folders.sort((a, b) => String(a.studentName).localeCompare(String(b.studentName)));
    videos.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
    res.json({ folders, videos });
}));

app.get('/api/admin/groups', requireAdmin, wrap(async (req, res) => {
    const snap = await groupsCol.get();
    const groups = [];
    snap.forEach((doc) => groups.push(doc.data()));
    res.json({ groups });
}));

app.post('/api/admin/groups', requireAdmin, wrap(async (req, res) => {
    const b = req.body || {};
    const name = V.str(b.name, { name: 'Group name', max: 100, required: true });
    if (!Array.isArray(b.studentIds) || b.studentIds.length > 500) throw new HttpError(400, 'studentIds must be a list.');
    const studentIds = b.studentIds.map((id) => V.idString(id, 'Student ID'));

    const groupId = b.id ? V.idString(b.id, 'Group ID') : crypto.randomUUID();
    const ref = groupsCol.doc(groupId);
    const existing = b.id ? await ref.get() : null;
    const groupData = {
        id: groupId,
        name,
        studentIds,
        zoomLink: existing && existing.exists ? (existing.data().zoomLink || '') : '',
        createdAt: existing && existing.exists ? existing.data().createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    await ref.set(groupData);
    res.json({ message: 'Group saved successfully', group: groupData });
}));

app.post('/api/admin/groups/:id/zoom', requireAdmin, wrap(async (req, res) => {
    const id = V.idString(req.params.id, 'Group ID');
    const zoomLink = V.optionalUrl(req.body && req.body.zoomLink, 'Zoom link');
    const ref = groupsCol.doc(id);
    if (!(await ref.get()).exists) throw new HttpError(404, 'Group not found');
    await ref.update({ zoomLink, updatedAt: new Date().toISOString() });
    res.json({ message: 'Zoom link updated successfully', group: (await ref.get()).data() });
}));

app.get('/api/admin/dmit-students', requireAdmin, wrap(async (req, res) => {
    const snap = await usersCol.get();
    const students = [];
    snap.forEach((doc) => {
        const u = doc.data();
        if (u.enrolledProgram && u.enrolledProgram.toLowerCase().includes('dmit')) {
            students.push({
                id: u.id, studentName: u.studentName, parentEmail: u.parentEmail,
                enrolledProgram: u.enrolledProgram, dmitReport: u.dmitReport || null
            });
        }
    });
    res.json({ students });
}));

// Upload a DMIT report PDF to Drive. Returns the Drive file id for the assign step.
app.post('/api/admin/upload-dmit-report', requireAdmin, (req, res, next) => {
    pdfUpload.single('reportFile')(req, res, (err) => (err ? next(err) : next()));
}, wrap(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'No report file provided.');
    const folderId = await ensureReportsFolder();
    const safeName = path.basename(req.file.originalname).replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    const created = await drive.files.create({
        requestBody: { name: `${Date.now()}-${safeName}`, parents: [folderId] },
        media: { mimeType: 'application/pdf', body: Readable.from(req.file.buffer) },
        fields: 'id, name, webViewLink'
    });
    // Reports are private to whoever holds the link; the link is only ever shown to that student.
    await drive.permissions.create({ fileId: created.data.id, requestBody: { role: 'reader', type: 'anyone' } });
    res.json({ fileId: created.data.id, fileUrl: created.data.webViewLink, originalName: safeName });
}));

app.post('/api/admin/assign-dmit-report', requireAdmin, wrap(async (req, res) => {
    const studentId = V.idString(req.body && req.body.studentId, 'Student ID');
    const fileId = V.str(req.body && req.body.fileId, { name: 'File ID', max: 128, required: true, pattern: /^[A-Za-z0-9_-]+$/ });

    const userRef = usersCol.doc(studentId);
    if (!(await userRef.get()).exists) throw new HttpError(404, 'Student not found.');

    // The URL is derived from Drive, never taken from the client.
    const file = await drive.files.get({ fileId, fields: 'id, name, webViewLink, mimeType' });
    if (file.data.mimeType !== 'application/pdf') throw new HttpError(400, 'File is not a PDF report.');

    const dmitReport = { fileId, url: file.data.webViewLink, name: file.data.name, uploadedAt: new Date().toISOString() };
    await userRef.update({ dmitReport });
    res.json({ message: 'Report assigned successfully', dmitReport });
}));

// ---------------------------------------------------------------------------
// Static site (local development only; Vercel serves frontend/ directly)
// ---------------------------------------------------------------------------
app.get(['/', '/index.html'], (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/initial_index.html'));
});
app.use(express.static(path.join(__dirname, '../frontend'), { index: false }));

// ---------------------------------------------------------------------------
// Errors — never leak internals to the client
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof multer.MulterError) {
        const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 20MB).' : 'Invalid upload.';
        return res.status(400).json({ error: msg });
    }
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body.' });
    console.error(`${req.method} ${req.path} failed:`, err);
    res.status(500).json({ error: 'Internal Server Error' });
});

module.exports = app;

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Awaken IQ Server running on http://localhost:${PORT}`);
    });
}
