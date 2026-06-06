const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 8000;
const DB_FILE = path.join(__dirname, '../database/database.json');

// Middleware
app.use(cors());
app.use(express.json());
app.use(cookieParser('awaken-iq-secret-key'));
app.use(express.urlencoded({ extended: true }));

// Helper function to read database
function readDatabase() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            fs.writeFileSync(DB_FILE, JSON.stringify({ users: [] }, null, 2));
        }
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('Error reading database:', err);
        return { users: [] };
    }
}

// Helper function to write database
function writeDatabase(data) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('Error writing database:', err);
    }
}

// Check logged in user session
app.get('/api/session', (req, res) => {
    const userEmail = req.signedCookies.userEmail;
    if (!userEmail) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const db = readDatabase();
    const user = db.users.find(u => u.parentEmail === userEmail);
    if (!user) {
        res.clearCookie('userEmail');
        return res.status(401).json({ error: 'User not found' });
    }
    
    // Send user data (without password)
    const { password, ...safeUser } = user;
    res.json({ user: safeUser });
});

// Register new user
app.post('/api/register', (req, res) => {
    const { studentInfo, parentInfo, courseInfo, paymentInfo, password } = req.body;
    
    if (!parentInfo || !parentInfo.email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }
    
    const db = readDatabase();
    const existingUser = db.users.find(u => u.parentEmail === parentInfo.email);
    if (existingUser) {
        return res.status(400).json({ error: 'Email already registered.' });
    }
    
    // Create new user entry
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
        password: password, // In a real app we'd hash this, but simple text is fine for prototype
        registrationDate: new Date().toISOString()
    };
    
    db.users.push(newUser);
    writeDatabase(db);
    
    // Set cookie session
    res.cookie('userEmail', newUser.parentEmail, {
        signed: true,
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 1 day
    });
    
    res.status(201).json({ message: 'Registration successful', userId: newUser.id });
});

// Login user
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }
    
    const db = readDatabase();
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

// Get list of registered students
app.get('/api/students', (req, res) => {
    const db = readDatabase();
    const studentList = db.users.map(u => ({
        id: u.id,
        name: u.studentName || 'Unknown Student',
        level: u.enrolledProgram || 'Level 1 Beginner',
        avatar: `https://i.pravatar.cc/120?img=${u.id.slice(-2)}`
    }));
    res.json({ students: studentList });
});

// Save class attendance log
app.post('/api/attendance', (req, res) => {
    const { date, records } = req.body;
    if (!records) {
        return res.status(400).json({ error: 'Records are required' });
    }
    
    const db = readDatabase();
    if (!db.attendance) {
        db.attendance = [];
    }
    
    const entry = {
        id: Date.now().toString(),
        date: date || new Date().toISOString(),
        records: records, // array of { studentId, name, present }
        savedAt: new Date().toISOString()
    };
    
    db.attendance.push(entry);
    writeDatabase(db);
    
    res.json({ message: 'Attendance saved successfully', entry });
});

// Get class attendance log history
app.get('/api/attendance', (req, res) => {
    const db = readDatabase();
    res.json({ attendance: db.attendance || [] });
});

// Serve static website files
app.use(express.static(path.join(__dirname, '../frontend')));

app.listen(PORT, () => {
    console.log(`Awaken IQ Server running on http://localhost:${PORT}`);
});
