const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc } = require('firebase/firestore');
const fs = require('fs');
const path = require('path');

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY || "YOUR_API_KEY",
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || "your-app.firebaseapp.com",
  projectId: process.env.FIREBASE_PROJECT_ID || "your-app",
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "your-app.firebasestorage.app",
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "YOUR_SENDER_ID",
  appId: process.env.FIREBASE_APP_ID || "YOUR_APP_ID",
  measurementId: process.env.FIREBASE_MEASUREMENT_ID || "YOUR_MEASUREMENT_ID"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const MGT_DB_FILE = path.join(__dirname, '../database/management_database.json');
const STD_DB_FILE = path.join(__dirname, '../database/student_database.json');

async function migrate() {
  console.log('Starting migration to Firestore (Client SDK)...');

  // 1. Migrate Users
  let users = [];
  
  // Read and merge data from management and student databases
  if (fs.existsSync(MGT_DB_FILE)) {
    try {
      const mgtData = JSON.parse(fs.readFileSync(MGT_DB_FILE, 'utf8'));
      if (mgtData.users && Array.isArray(mgtData.users)) {
        users = mgtData.users;
        console.log(`Loaded ${users.length} users from management database.`);
      }
    } catch (e) {
      console.error('Error reading management database:', e);
    }
  }

  if (fs.existsSync(STD_DB_FILE)) {
    try {
      const stdData = JSON.parse(fs.readFileSync(STD_DB_FILE, 'utf8'));
      if (stdData.users && Array.isArray(stdData.users)) {
        console.log(`Loaded ${stdData.users.length} users from student database for merging.`);
        // Merge student profiles with management profiles
        stdData.users.forEach(su => {
          const index = users.findIndex(u => u.id === su.id);
          if (index !== -1) {
            users[index] = { ...users[index], ...su };
          } else {
            users.push(su);
          }
        });
      }
    } catch (e) {
      console.error('Error reading student database:', e);
    }
  }

  // Upload Users to Firestore
  console.log(`Uploading ${users.length} merged users to 'users' collection...`);
  for (const user of users) {
    if (!user.id) {
      console.warn('Skipping user without ID:', user);
      continue;
    }
    await setDoc(doc(db, 'users', user.id), user);
    console.log(`Migrated user: ${user.studentName || user.parentEmail} (ID: ${user.id})`);
  }

  // 2. Migrate Attendance
  if (fs.existsSync(MGT_DB_FILE)) {
    try {
      const mgtData = JSON.parse(fs.readFileSync(MGT_DB_FILE, 'utf8'));
      if (mgtData.attendance && Array.isArray(mgtData.attendance)) {
        console.log(`Uploading ${mgtData.attendance.length} attendance records to 'attendance' collection...`);
        for (const record of mgtData.attendance) {
          const docId = record.id || Date.now().toString() + Math.random().toString(36).substr(2, 5);
          await setDoc(doc(db, 'attendance', docId), record);
        }
        console.log('Attendance records migrated.');
      }
    } catch (e) {
      console.error('Error migrating attendance:', e);
    }
  }

  // 3. Migrate Feedbacks
  if (fs.existsSync(MGT_DB_FILE)) {
    try {
      const mgtData = JSON.parse(fs.readFileSync(MGT_DB_FILE, 'utf8'));
      if (mgtData.feedbacks && Array.isArray(mgtData.feedbacks)) {
        console.log(`Uploading ${mgtData.feedbacks.length} feedback records to 'feedbacks' collection...`);
        for (const feedback of mgtData.feedbacks) {
          const docId = feedback.id || Date.now().toString() + Math.random().toString(36).substr(2, 5);
          await setDoc(doc(db, 'feedbacks', docId), feedback);
        }
        console.log('Feedback records migrated.');
      }
    } catch (e) {
      console.error('Error migrating feedbacks:', e);
    }
  }

  console.log('Migration completed successfully!');
}

migrate()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
