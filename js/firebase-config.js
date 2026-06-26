// ============================================================
// Firebase Configuration
// ============================================================

const firebaseConfig = {
  apiKey:            "AIzaSyDotsT4p39PbnP8eL_8hy7imsRksmv9neo",
  authDomain:        "chat-ce170.firebaseapp.com",
  projectId:         "chat-ce170",
  storageBucket:     "chat-ce170.firebasestorage.app",
  messagingSenderId: "239354855258",
  appId:             "1:239354855258:web:eb050744833b5bb7a8bd63",
  measurementId:     "G-22GMELEH4Z"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Service references (available globally)
const auth = firebase.auth();
const db   = firebase.firestore();

// Storage is only available on pages that load the storage SDK
let storage = null;
try {
  storage = firebase.storage();
} catch (e) {
  // Storage SDK not loaded on this page — that's fine for login page
}

// Keep auth state across page reloads
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

console.log("[Firebase] Initialized successfully");
