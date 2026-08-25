require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const cors = require('cors');
const multer = require('multer');
const Razorpay = require('razorpay');

const app = express();
const PORT = process.env.PORT || 8080;
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_T5YV4AoQWgbbqc',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'y8fwpUuPXTEZYBN1zyq3EgV2'
});
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const serviceAccount = require('./awakeniq-2d15a-firebase-adminsdk-fbsvc-7d8e904cd1.json');

initializeApp({
    credential: cert(serviceAccount)
});
const firestoreDb = getFirestore();

// Google Drive Config
const KEY_FILE_PATH = path.join(__dirname, 'awakeniq-ccf56bc780a0.json');
const PARENT_FOLDER_ID = '1547TNnAafDreFOQgq-EuEQnFZtaTWRke';

const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE_PATH,
    scopes: ['https://www.googleapis.com/auth/drive']
});
const drive = google.drive({ version: 'v3', auth });

// Helper to get or create client folder on Drive
async function getOrCreateStudentFolder(studentName) {
    try {
        const response = await drive.files.list({
            q: `mimeType='application/vnd.google-apps.folder' and name='${studentName.replace(/'/g, "\\'")}' and '${PARENT_FOLDER_ID}' in parents and trashed = false`,
            fields: 'files(id, name)',
            spaces: 'drive'
        });

        if (response.data.files && response.data.files.length > 0) {
            return response.data.files[0].id;
        }

        const fileMetadata = {
            name: studentName,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [PARENT_FOLDER_ID]
        };

        const folder = await drive.files.create({
            resource: fileMetadata,
            fields: 'id'
        });

        return folder.data.id;
    } catch (err) {
        console.error('Error in getOrCreateStudentFolder:', err);
        throw err;
    }
}

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

// Helper functions for Firestore operations
async function getUserById(userId) {
    const docRef = firestoreDb.collection('users').doc(userId);
    const docSnap = await docRef.get();
    return docSnap.exists ? docSnap.data() : null;
}

async function getUserByEmail(email) {
    const querySnapshot = await firestoreDb.collection('users').where('parentEmail', '==', email).get();
    if (!querySnapshot.empty) {
        return querySnapshot.docs[0].data();
    }
    return null;
}

async function saveUser(user) {
    await firestoreDb.collection('users').doc(user.id).set(user);
}

// Check logged in user session (Student/Parent access)
app.get('/api/session', async (req, res) => {
    const userEmail = req.signedCookies.userEmail;
    if (!userEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    try {
        const user = await getUserByEmail(userEmail);
        if (!user) {
            res.clearCookie('userEmail');
            return res.status(401).json({ error: 'User not found' });
        }
        
        // Send user data (without password) - limited to their own profile
        const { password, ...safeUser } = user;
        
        // Get user's assigned group if any
        let group = null;
        try {
            const groupSnap = await firestoreDb.collection('groups').where('studentIds', 'array-contains', user.id).get();
            if (!groupSnap.empty) {
                group = groupSnap.docs[0].data();
            }
        } catch (groupErr) {
            console.error('Error fetching user group:', groupErr);
        }
        
        res.json({ user: safeUser, group });
    } catch (err) {
        console.error('Session API error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Register new user
app.post('/api/register', async (req, res) => {
    const { studentInfo, parentInfo, courseInfo, paymentInfo, password } = req.body;
    
    if (!parentInfo || !parentInfo.email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }
    
    try {
        const existingUser = await getUserByEmail(parentInfo.email);
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
        
        await saveUser(newUser);
        
        // Set cookie session
        res.cookie('userEmail', newUser.parentEmail, {
            signed: true,
            httpOnly: true,
            maxAge: 24 * 60 * 60 * 1000 // 1 day
        });
        
        res.status(201).json({ message: 'Registration successful', userId: newUser.id });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: 'Failed to register user.' });
    }
});

// Login user (Student Portal authentication)
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }
    
    try {
        const user = await getUserByEmail(email);
        
        if (!user || user.password !== password) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }
        
        // Set cookie session
        res.cookie('userEmail', user.parentEmail, {
            signed: true,
            httpOnly: true,
            maxAge: 24 * 60 * 60 * 1000 // 1 day
        });
        
        res.json({ message: 'Login successful', userId: user.id });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Failed to log in.' });
    }
});

// Logout user
app.post('/api/logout', (req, res) => {
    res.clearCookie('userEmail');
    res.json({ message: 'Logout successful' });
});


// Add student improvement video (Parent access - File Upload)
app.post('/api/improvements', upload.single('videoFile'), async (req, res) => {
    const userEmail = req.signedCookies.userEmail;
    if (!userEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const { title } = req.body;
    if (!title || !req.file) {
        return res.status(400).json({ error: 'Title and Video File are required.' });
    }
    
    try {
        // Fetch user from DB
        const stdUser = await getUserByEmail(userEmail);
        if (!stdUser) {
            // Cleanup temp file
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            return res.status(404).json({ error: 'User not found.' });
        }
        
        let videoUrl = '';
        
        try {
            // Get student name for folder division
            const studentName = stdUser.studentName || 'Unclassified Student';
            
            // Get or Create Student folder on Google Drive
            const studentFolderId = await getOrCreateStudentFolder(studentName);
            
            // Upload the video to Google Drive
            const fileMetadata = {
                name: `${Date.now()}-${req.file.originalname}`,
                parents: [studentFolderId]
            };
            const media = {
                mimeType: req.file.mimetype,
                body: fs.createReadStream(req.file.path)
            };
            
            const driveFile = await drive.files.create({
                resource: fileMetadata,
                media: media,
                fields: 'id, webViewLink'
            });
            
            // We will store the Google Drive webViewLink as the video URL
            videoUrl = driveFile.data.webViewLink;
            
            // Remove file locally
            if (fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
        } catch (driveErr) {
            console.warn('Google Drive upload failed, falling back to local storage:', driveErr);
            // Since it failed, we keep the file locally in frontend/uploads
            // The file is already stored in req.file.path by multer!
            // We construct the local relative path:
            videoUrl = `/uploads/${req.file.filename}`;
        }
        
        if (!stdUser.videos) {
            stdUser.videos = [];
        }
        
        const newVideo = {
            id: Date.now().toString(),
            title,
            url: videoUrl,
            addedAt: new Date().toISOString()
        };
        
        stdUser.videos.push(newVideo);
        await saveUser(stdUser);
        
        res.status(201).json({ message: 'Video uploaded successfully', videos: stdUser.videos });
    } catch (err) {
        console.error('Upload error:', err);
        // Clean up temp file on error
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: 'Failed to upload video.' });
    }
});

// Get all student improvements (Admin access)
app.get('/api/admin/improvements', async (req, res) => {
    try {
        const querySnapshot = await firestoreDb.collection('users').get();
        const allVideos = [];
        
        querySnapshot.forEach(doc => {
            const user = doc.data();
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
    } catch (err) {
        console.error('Admin improvements API error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Get list of registered students (Management/Company access only)
app.get('/api/students', async (req, res) => {
    try {
        const querySnapshot = await firestoreDb.collection('users').get();
        const studentList = [];
        
        querySnapshot.forEach(doc => {
            const u = doc.data();
            studentList.push({
                id: u.id,
                name: u.studentName || 'Unknown Student',
                level: u.enrolledProgram || 'Level 1 Beginner',
                avatar: `https://i.pravatar.cc/120?img=${u.id.slice(-2)}`
            });
        });
        
        res.json({ students: studentList });
    } catch (err) {
        console.error('Students API error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Save class attendance log (Management/Company access only)
app.post('/api/attendance', async (req, res) => {
    const { date, records } = req.body;
    if (!records) {
        return res.status(400).json({ error: 'Records are required' });
    }
    
    try {
        const entryId = Date.now().toString();
        const entry = {
            id: entryId,
            date: date || new Date().toISOString(),
            records: records,
            savedAt: new Date().toISOString()
        };
        
        await firestoreDb.collection('attendance').doc(entryId).set(entry);
        res.json({ message: 'Attendance saved successfully', entry });
    } catch (err) {
        console.error('Attendance save API error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Get class attendance log history (Management/Company access only)
app.get('/api/attendance', async (req, res) => {
    try {
        const querySnapshot = await firestoreDb.collection('attendance').get();
        const attendanceList = [];
        
        querySnapshot.forEach(doc => {
            attendanceList.push(doc.data());
        });
        
        res.json({ attendance: attendanceList });
    } catch (err) {
        console.error('Attendance get API error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Add feedback from parent/student
app.post('/api/feedback', async (req, res) => {
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
        social_confidence
    } = req.body;
    const rating = parseInt(academicPerformanceRating, 10);
    
    if (isNaN(rating) || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Valid academic performance rating (1-5) is required.' });
    }
    
    try {
        const user = await getUserByEmail(userEmail);
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }
        
        const feedbackId = Date.now().toString();
        const feedbackEntry = {
            id: feedbackId,
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
            submittedAt: new Date().toISOString()
        };
        
        // Save to feedbacks collection
        await firestoreDb.collection('feedbacks').doc(feedbackId).set(feedbackEntry);
        
        // Also save under the student's record in student database if useful
        if (!user.feedbacks) {
            user.feedbacks = [];
        }
        user.feedbacks.push(feedbackEntry);
        await saveUser(user);
        
        res.status(201).json({ message: 'Feedback submitted successfully', feedback: feedbackEntry });
    } catch (err) {
        console.error('Feedback POST API error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Get all feedback for management console
app.get('/api/admin/feedbacks', async (req, res) => {
    try {
        const querySnapshot = await firestoreDb.collection('feedbacks').get();
        const feedbacks = [];
        
        querySnapshot.forEach(doc => {
            feedbacks.push(doc.data());
        });
        
        // Sort by submission date descending
        feedbacks.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
        res.json({ feedbacks });
    } catch (err) {
        console.error('Admin feedbacks API error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
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

// Group Management APIs
app.get('/api/admin/groups', async (req, res) => {
    try {
        const querySnapshot = await firestoreDb.collection('groups').get();
        const groups = [];
        querySnapshot.forEach(doc => {
            groups.push(doc.data());
        });
        res.json({ groups });
    } catch (err) {
        console.error('Error fetching groups:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post('/api/admin/groups', async (req, res) => {
    const { id, name, studentIds } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Group name is required' });
    }
    try {
        const groupId = id || Date.now().toString();
        let zoomLink = '';
        if (id) {
            const docRef = firestoreDb.collection('groups').doc(id);
            const docSnap = await docRef.get();
            if (docSnap.exists) {
                zoomLink = docSnap.data().zoomLink || '';
            }
        }
        const groupData = {
            id: groupId,
            name: name,
            studentIds: studentIds || [],
            zoomLink: zoomLink,
            createdAt: new Date().toISOString()
        };
        await firestoreDb.collection('groups').doc(groupId).set(groupData);
        res.status(200).json({ message: 'Group saved successfully', group: groupData });
    } catch (err) {
        console.error('Error saving group:', err);
        res.status(500).json({ error: 'Failed to save group' });
    }
});

app.post('/api/admin/groups/:id/zoom', async (req, res) => {
    const { id } = req.params;
    const { zoomLink } = req.body;
    try {
        const docRef = firestoreDb.collection('groups').doc(id);
        const docSnap = await docRef.get();
        if (!docSnap.exists) {
            return res.status(404).json({ error: 'Group not found' });
        }
        const groupData = docSnap.data();
        groupData.zoomLink = zoomLink || '';
        await docRef.set(groupData);
        res.status(200).json({ message: 'Zoom link updated successfully', group: groupData });
    } catch (err) {
        console.error('Error updating zoom link:', err);
        res.status(500).json({ error: 'Failed to update Zoom link' });
    }
});

// Zoom Signature Generator
app.post('/api/zoom-signature', (req, res) => {
    try {
        const { meetingNumber, role } = req.body;
        const sdkKey = process.env.ZOOM_SDK_KEY || 'dummy_sdk_key';
        const sdkSecret = process.env.ZOOM_SDK_SECRET || 'dummy_sdk_secret';
        
        if (!meetingNumber) {
            return res.status(400).json({ error: 'meetingNumber is required' });
        }
        
        const crypto = require('crypto');
        const iat = Math.round(new Date().getTime() / 1000) - 30;
        const exp = iat + 60 * 60 * 2;
        const oHeader = { alg: 'HS256', typ: 'JWT' };
        const oPayload = {
            sdkKey: sdkKey,
            mn: meetingNumber,
            role: role || 0,
            iat: iat,
            exp: exp,
            appKey: sdkKey,
            tokenExp: exp
        };
        
        const sHeader = Buffer.from(JSON.stringify(oHeader)).toString('base64url');
        const sPayload = Buffer.from(JSON.stringify(oPayload)).toString('base64url');
        const signature = crypto.createHmac('sha256', sdkSecret)
            .update(sHeader + '.' + sPayload)
            .digest('base64url');
        
        const token = sHeader + '.' + sPayload + '.' + signature;
        res.json({ signature: token, sdkKey });
    } catch (error) {
        console.error('Zoom signature error:', error);
        res.status(500).json({ error: 'Failed to generate signature' });
    }
});

// Register Zoom Class attendance
app.post('/api/attend-class', async (req, res) => {
    const userEmail = req.signedCookies.userEmail;
    if (!userEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    const { zoomLink } = req.body;
    if (!zoomLink) {
        return res.status(400).json({ error: 'zoomLink is required' });
    }
    try {
        const user = await getUserByEmail(userEmail);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (!user.attendedMeetings) {
            user.attendedMeetings = [];
        }
        
        // Prevent duplicate attendance records for the exact same link on the same day
        const todayStr = new Date().toISOString().slice(0, 10);
        const alreadyAttended = user.attendedMeetings.some(m => m.zoomLink === zoomLink && m.date === todayStr);
        
        if (!alreadyAttended) {
            user.attendedMeetings.push({
                zoomLink,
                date: todayStr,
                timestamp: new Date().toISOString()
            });
            await saveUser(user);
        }
        
        res.status(200).json({ message: 'Attendance recorded successfully', attendedMeetings: user.attendedMeetings });
    } catch (error) {
        console.error('Error saving class attendance:', error);
        res.status(500).json({ error: 'Failed to record attendance' });
    }
});

// Get all students enrolled in a DMIT program
app.get('/api/admin/dmit-students', async (req, res) => {
    try {
        const querySnapshot = await firestoreDb.collection('users').get();
        const dmitStudents = [];
        
        querySnapshot.forEach(doc => {
            const u = doc.data();
            if (u.enrolledProgram && u.enrolledProgram.toLowerCase().includes('dmit')) {
                dmitStudents.push({
                    id: u.id,
                    studentName: u.studentName,
                    parentEmail: u.parentEmail,
                    enrolledProgram: u.enrolledProgram,
                    dmitReport: u.dmitReport || null
                });
            }
        });
        
        res.json({ students: dmitStudents });
    } catch (error) {
        console.error('Error fetching DMIT students:', error);
        res.status(500).json({ error: 'Failed to fetch DMIT students.' });
    }
});

// Upload DMIT report file
app.post('/api/admin/upload-dmit-report', upload.single('reportFile'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No report file provided.' });
        }
        const fileUrl = `/uploads/${req.file.filename}`;
        res.status(200).json({ fileUrl, originalName: req.file.originalname });
    } catch (error) {
        console.error('Error uploading DMIT report:', error);
        res.status(500).json({ error: 'Failed to upload report file.' });
    }
});

// Assign report to student
app.post('/api/admin/assign-dmit-report', async (req, res) => {
    try {
        const { studentId, fileUrl, originalName } = req.body;
        if (!studentId || !fileUrl) {
            return res.status(400).json({ error: 'Student ID and File URL are required.' });
        }
        
        const user = await getUserById(studentId);
        if (!user) {
            return res.status(404).json({ error: 'Student not found.' });
        }
        
        const dmitReport = {
            url: fileUrl,
            name: originalName || 'dmit-report.pdf',
            uploadedAt: new Date().toISOString()
        };
        
        user.dmitReport = dmitReport;
        await saveUser(user);
        
        res.status(200).json({ message: 'Report assigned successfully', dmitReport });
    } catch (error) {
        console.error('Error assigning DMIT report:', error);
        res.status(500).json({ error: 'Failed to assign report.' });
    }
});

// Route index requests to initial_index.html since we deleted index.html
app.get(['/', '/index.html'], (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/initial_index.html'));
});

// Serve static website files
app.use(express.static(path.join(__dirname, '../frontend')));

app.listen(PORT, () => {
    console.log(`Awaken IQ Server running on http://localhost:${PORT}`);
});
