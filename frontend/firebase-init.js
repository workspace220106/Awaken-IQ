// Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCchu0t7PaQeTwqHDEDvbE9Q6YCzZZS9yM",
  authDomain: "awakeniq-2d15a.firebaseapp.com",
  projectId: "awakeniq-2d15a",
  storageBucket: "awakeniq-2d15a.firebasestorage.app",
  messagingSenderId: "453380259614",
  appId: "1:453380259614:web:648cad3b51d92eb0f7130f",
  measurementId: "G-G3100S0YD9"
};

// Initialize Firebase
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

// Global service shortcuts
const db = firebase.firestore();
const storage = firebase.storage();

// Expose to window for global access
window.firebaseDb = db;
window.firebaseStorage = storage;
