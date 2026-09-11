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
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(cookieParser(SESSION_SECRET));

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please try again in 15 minutes.' }
});
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down.' }
});
app.use('/api/', apiLimiter);

// ---------------------------------------------------------------------------
// Sessions — one signed, httpOnly cookie carrying { uid, role }
// ---------------------------------------------------------------------------
const SESSION_COOKIE = 'session';
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function setSession(res, payload) {
    res.cookie(SESSION_COOKIE, payload, {
        signed: true,
        httpOnly: true,
        sameSite: 'lax',
        secure: IS_PROD,
        maxAge: SESSION_MAX_AGE_MS,
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
        // Legacy plaintext row: verify once, then upgrade to a hash and drop the plaintext.
        ok = safeEqual(user.password, plainPassword);
        if (ok) {
            await usersCol.doc(user.id).update({
                passwordHash: await bcrypt.hash(plainPassword, 12),
                password: FieldValue.delete()
            });
        }
    }
    if (!ok) return invalid();

    setSession(res, { uid: user.id, role: 'user' });
    res.json({ message: 'Login successful', userId: user.id });
}));

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
        const record = (s.records || []).find((r) => r && (r.studentId === me.id || (r.name && String(r.name).toLowerCase() === name)));
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

    const orderRef = ordersCol.doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) throw new HttpError(400, 'Unknown order.');
    if (orderSnap.data().status === 'created') {
        await orderRef.update({ status: 'paid', paymentId, paidAt: new Date().toISOString() });
    }
    res.json({ status: 'ok', message: 'Payment verified successfully.' });
}));

// ---------------------------------------------------------------------------
// Management console
// ---------------------------------------------------------------------------
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
