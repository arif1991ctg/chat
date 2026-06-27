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

// Enable offline persistence
db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
  if (err.code === 'failed-precondition') {
    console.warn('[Firebase] Offline persistence failed: Multiple tabs open');
  } else if (err.code === 'unimplemented') {
    console.warn('[Firebase] Offline persistence not supported by browser');
  }
});

// Storage is only available on pages that load the storage SDK
let storage = null;
try {
  storage = firebase.storage();
} catch (e) {
  // Storage SDK not loaded on this page — that's fine for login page
}

// Messaging reference
let messaging = null;
try {
  messaging = firebase.messaging();
} catch (e) {
  // Messaging SDK not loaded or not supported
}

// VAPID Public Key for Web Push (replace with your actual key in console)
const FCM_VAPID_KEY = "BPEa0j4Ym6B63Y9nN-k59P4n2QzO5e8RzX_P4T2V0w1m-A7C8D8E9F0G1H2I3J4K5L6M7N8O9P0";

// Keep auth state across page reloads
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

console.log("[Firebase] Initialized successfully with offline persistence");

// Global Toast notification helper
window.showToast = function (message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  container.appendChild(toast);

  // Automatically transition and remove the toast after 3 seconds
  setTimeout(() => {
    toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3000);
};

