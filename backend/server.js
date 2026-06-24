require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const Razorpay = require('razorpay');

const app = express();
const PORT = 8000;
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_T5YV4AoQWgbbqc',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'y8fwpUuPXTEZYBN1zyq3EgV2'
});
const MGT_DB_FILE = path.join(__dirname, '../database/management_database.json');
const STD_DB_FILE = path.join(__dirname, '../database/student_database.json');

// Configure multer storage for uploaded progress videos
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, '../frontend/uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(cookieParser('awaken-iq-secret-key'));
app.use(express.urlencoded({ extended: true }));

// Helper function to read management database
function readMgtDatabase() {
    try {
        if (!fs.existsSync(MGT_DB_FILE)) {
            fs.writeFileSync(MGT_DB_FILE, JSON.stringify({ users: [], attendance: [], feedbacks: [] }, null, 2));
        }
        const data = fs.readFileSync(MGT_DB_FILE, 'utf8');
        const parsed = JSON.parse(data);
        if (!parsed.feedbacks) {
            parsed.feedbacks = [];
        }
        return parsed;
    } catch (err) {
        console.error('Error reading management database:', err);
        return { users: [], attendance: [], feedbacks: [] };
    }
}

// Helper function to write management database
function writeMgtDatabase(data) {
    try {
        fs.writeFileSync(MGT_DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('Error writing management database:', err);
    }
}

// Helper function to read student database
function readStdDatabase() {
    try {
        if (!fs.existsSync(STD_DB_FILE)) {
            fs.writeFileSync(STD_DB_FILE, JSON.stringify({ users: [] }, null, 2));
        }
        const data = fs.readFileSync(STD_DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('Error reading student database:', err);
        return { users: [] };
    }
}

// Helper function to write student database
function writeStdDatabase(data) {
    try {
        fs.writeFileSync(STD_DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('Error writing student database:', err);
    }
}

// Sync users details from management database to student database on startup if needed
(function syncDatabases() {
    const mgtDb = readMgtDatabase();
    const stdDb = readStdDatabase();
    
    // If student database users are simplified or empty, sync them from management database
    if (mgtDb.users && mgtDb.users.length > 0) {
        // We ensure all users in management database exist in student database with full profiles
        stdDb.users = mgtDb.users.map(mu => {
            const existingStd = stdDb.users.find(su => su.id === mu.id);
            // Retain credentials but merge full profile details
            return { ...mu, ...existingStd, password: mu.password };
        });
        writeStdDatabase(stdDb);
        console.log('Database synchronization completed successfully.');
    }
})();

// Check logged in user session (Student/Parent access)
app.get('/api/session', (req, res) => {
    const userEmail = req.signedCookies.userEmail;
    if (!userEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const db = readStdDatabase();
    const user = db.users.find(u => u.parentEmail === userEmail);
    if (!user) {
        res.clearCookie('userEmail');
        return res.status(401).json({ error: 'User not found' });
    }
    
    // Send user data (without password) - limited to their own profile
    const { password, ...safeUser } = user;
    res.json({ user: safeUser });
});

// Register new user (Adds to both databases)
app.post('/api/register', (req, res) => {
    const { studentInfo, parentInfo, courseInfo, paymentInfo, password } = req.body;
    
    if (!parentInfo || !parentInfo.email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }
    
    const mgtDb = readMgtDatabase();
    const existingUser = mgtDb.users.find(u => u.parentEmail === parentInfo.email);
    if (existingUser) {
        return res.status(400).json({ error: 'Email already registered.' });
    }
    
    // Create new full user profile entry
    const newUser = {
        id: Date.now().toString(),
        // Student Info
        studentName: studentInfo.fullName,
        studentAge: studentInfo.age,
        studentGender: studentInfo.gender,
        studentGrade: studentInfo.grade,
        studentSchool: studentInfo.schoolName,
        studentSpecialNeeds: studentInfo.specialNeeds || false,
        studentSpecialDetails: studentInfo.specialDetails || '',
        
        // Parent Info
        parentName: parentInfo.parent_name,
        parentRelationship: parentInfo.relationship,
        parentMobile: parentInfo.mobile,
        parentAltMobile: parentInfo.alt_mobile,
        parentEmail: parentInfo.email,
        parentAddress: parentInfo.address,
        parentCity: parentInfo.city,
        parentState: parentInfo.state,
        parentPincode: parentInfo.pincode,
        
        // Program & Payment Info
        enrolledProgram: courseInfo ? courseInfo.program : 'None Selected',
        duration: courseInfo ? courseInfo.duration : '',
        paymentStatus: paymentInfo ? (paymentInfo.status || 'Pending') : 'Pending',
        paymentMethod: paymentInfo ? (paymentInfo.method || 'Credit/Debit') : 'Credit/Debit',
        
        // Credentials
        password: password,
        registrationDate: new Date().toISOString()
    };
    
    // Save to Management Database (Master Copy)
    mgtDb.users.push(newUser);
    writeMgtDatabase(mgtDb);
    
    // Save to Student Database (Student Access Copy)
    const stdDb = readStdDatabase();
    stdDb.users.push(newUser);
    writeStdDatabase(stdDb);
    
    // Set cookie session
    res.cookie('userEmail', newUser.parentEmail, {
        signed: true,
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 1 day
    });
    
    res.status(201).json({ message: 'Registration successful', userId: newUser.id });
});

// Login user (Student Portal authentication)
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }
    
    const db = readStdDatabase();
    const user = db.users.find(u => u.parentEmail === email && u.password === password);
    
    if (!user) {
        return res.status(401).json({ error: 'Invalid email or password.' });
    }
    
    // Set cookie session
    res.cookie('userEmail', user.parentEmail, {
        signed: true,
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 1 day
    });
    
    res.json({ message: 'Login successful', userId: user.id });
});

// Logout user
app.post('/api/logout', (req, res) => {
    res.clearCookie('userEmail');
    res.json({ message: 'Logout successful' });
});

// Add student improvement video (Parent access - File Upload)
app.post('/api/improvements', upload.single('videoFile'), (req, res) => {
    const userEmail = req.signedCookies.userEmail;
    if (!userEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const { title } = req.body;
    if (!title || !req.file) {
        return res.status(400).json({ error: 'Title and Video File are required.' });
    }
    
    // Construct the static file URL path
    const relativeUrl = `/uploads/${req.file.filename}`;
    
    // Update Student Database
    const stdDb = readStdDatabase();
    const stdUser = stdDb.users.find(u => u.parentEmail === userEmail);
    if (!stdUser) {
        return res.status(404).json({ error: 'User not found.' });
    }
    if (!stdUser.videos) {
        stdUser.videos = [];
    }
    const newVideo = {
        id: Date.now().toString(),
        title,
        url: relativeUrl,
        addedAt: new Date().toISOString()
    };
    stdUser.videos.push(newVideo);
    writeStdDatabase(stdDb);
    
    // Synchronize to Management Database
    const mgtDb = readMgtDatabase();
    const mgtUser = mgtDb.users.find(u => u.parentEmail === userEmail);
    if (mgtUser) {
        if (!mgtUser.videos) {
            mgtUser.videos = [];
        }
        mgtUser.videos.push(newVideo);
        writeMgtDatabase(mgtDb);
    }
    
    res.status(201).json({ message: 'Video uploaded successfully', videos: stdUser.videos });
});

// Get all student improvements (Admin access)
app.get('/api/admin/improvements', (req, res) => {
    const db = readMgtDatabase();
    const allVideos = [];
    
    db.users.forEach(user => {
        if (user.videos && user.videos.length > 0) {
            user.videos.forEach(vid => {
                allVideos.push({
                    studentName: user.studentName,
                    programName: user.enrolledProgram,
                    videoTitle: vid.title,
                    videoUrl: vid.url,
                    addedAt: vid.addedAt
                });
            });
        }
    });
    
    // Sort by date descending
    allVideos.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
    res.json({ videos: allVideos });
});

// Get list of registered students (Management/Company access only - reads from Management Database)
app.get('/api/students', (req, res) => {
    const db = readMgtDatabase();
    const studentList = db.users.map(u => ({
        id: u.id,
        name: u.studentName || 'Unknown Student',
        level: u.enrolledProgram || 'Level 1 Beginner',
        avatar: `https://i.pravatar.cc/120?img=${u.id.slice(-2)}`
    }));
    res.json({ students: studentList });
});

// Save class attendance log (Management/Company access only - saves to Management Database)
app.post('/api/attendance', (req, res) => {
    const { date, records } = req.body;
    if (!records) {
        return res.status(400).json({ error: 'Records are required' });
    }
    
    const db = readMgtDatabase();
    if (!db.attendance) {
        db.attendance = [];
    }
    
    const entry = {
        id: Date.now().toString(),
        date: date || new Date().toISOString(),
        records: records,
        savedAt: new Date().toISOString()
    };
    
    db.attendance.push(entry);
    writeMgtDatabase(db);
    
    res.json({ message: 'Attendance saved successfully', entry });
});

// Get class attendance log history (Management/Company access only - reads from Management Database)
app.get('/api/attendance', (req, res) => {
    const db = readMgtDatabase();
    res.json({ attendance: db.attendance || [] });
});

// Add feedback from parent/student
app.post('/api/feedback', (req, res) => {
    const userEmail = req.signedCookies.userEmail;
    if (!userEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const {
        academicPerformanceRating,
        comments,
        focus_concentration,
        creativity_imagination,
        intuition,
        immunity_health,
        social_confidence,
        year,
        term
    } = req.body;
    const rating = parseInt(academicPerformanceRating, 10);
    
    if (isNaN(rating) || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Valid academic performance rating (1-5) is required.' });
    }
    
    const stdDb = readStdDatabase();
    const user = stdDb.users.find(u => u.parentEmail === userEmail);
    if (!user) {
        return res.status(404).json({ error: 'User not found.' });
    }
    
    const db = readMgtDatabase();
    if (!db.feedbacks) {
        db.feedbacks = [];
    }
    
    const feedbackEntry = {
        id: Date.now().toString(),
        studentId: user.id,
        studentName: user.studentName || 'Unknown Student',
        parentEmail: user.parentEmail,
        parentName: user.parentName || 'Unknown Parent',
        enrolledProgram: user.enrolledProgram || 'None Selected',
        academicPerformanceRating: rating,
        comments: comments || '',
        focus_concentration: focus_concentration || '',
        creativity_imagination: creativity_imagination || '',
        intuition: intuition || '',
        immunity_health: immunity_health || '',
        social_confidence: social_confidence || '',
        year: year || '',
        term: term || '',
        submittedAt: new Date().toISOString()
    };
    
    db.feedbacks.push(feedbackEntry);
    writeMgtDatabase(db);
    
    // Also save under the student's record in student database if useful
    if (!user.feedbacks) {
        user.feedbacks = [];
    }
    user.feedbacks.push(feedbackEntry);
    writeStdDatabase(stdDb);
    
    res.status(201).json({ message: 'Feedback submitted successfully', feedback: feedbackEntry });
});

// Get all feedback for management console
app.get('/api/admin/feedbacks', (req, res) => {
    const db = readMgtDatabase();
    const feedbacks = db.feedbacks || [];
    // Sort by submission date descending
    feedbacks.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    res.json({ feedbacks });
});

// Create Razorpay Order
app.post('/api/create-order', async (req, res) => {
    try {
        const { amount, currency, receipt } = req.body;
        
        // Validate amount is present and is at least 100 paise (1 INR / minimum transaction size)
        if (!amount || typeof amount !== 'number' || amount < 100) {
            return res.status(400).json({ error: 'Amount is required and must be at least 100 paise.' });
        }

        const options = {
            amount: amount,
            currency: currency || 'INR',
            receipt: receipt || `receipt_${Date.now()}`
        };

        const order = await razorpay.orders.create(options);
        
        res.status(200).json({
            order_id: order.id,
            amount: order.amount,
            currency: order.currency,
            key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_T5YV4AoQWgbbqc'
        });
    } catch (error) {
        console.error('Error creating Razorpay order:', error);
        
        if (error.statusCode === 401) {
            return res.status(401).json({ error: 'Razorpay authentication failed. Check API keys.' });
        }
        
        res.status(500).json({ error: error.message || 'Failed to create order' });
    }
});

// Verify Razorpay Signature
app.post('/api/verify-payment', (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ error: 'Missing required signature verification fields.' });
        }
        
        const crypto = require('crypto');
        const hmac = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'y8fwpUuPXTEZYBN1zyq3EgV2');
        hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
        const generated_signature = hmac.digest('hex');
        
        if (generated_signature === razorpay_signature) {
            res.status(200).json({ status: 'ok', message: 'Payment verified successfully.' });
        } else {
            console.error('Signature mismatch: Payment signature verification failed.');
            res.status(400).json({ error: 'Signature verification failed. Potential tampering.' });
        }
    } catch (error) {
        console.error('Error verifying Razorpay signature:', error);
        res.status(500).json({ error: 'Failed to verify payment' });
    }
});

// Serve static website files
app.use(express.static(path.join(__dirname, '../frontend')));

app.listen(PORT, () => {
    console.log(`Awaken IQ Server running on http://localhost:${PORT}`);
});
