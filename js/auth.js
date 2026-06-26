// ============================================================
// Authentication Module
// Handles login, logout, and auth state management
// Uses phone number as email alias: phone@chatapp.com
// ============================================================

(function () {
  'use strict';

  const EMAIL_DOMAIN = '@chatapp.com';

  // Convert phone number to email format for Firebase Auth
  function phoneToEmail(phone) {
    const cleaned = phone.replace(/[\s\-\(\)]/g, '');
    return cleaned + EMAIL_DOMAIN;
  }

  // Get phone from email
  function emailToPhone(email) {
    return email.replace(EMAIL_DOMAIN, '');
  }

  // ── Auth State Listener (runs on every page) ──
  auth.onAuthStateChanged(async (user) => {
    const isLoginPage = window.location.pathname === '/' ||
                        window.location.pathname.endsWith('index.html') ||
                        window.location.pathname === '';

    if (user) {
      // User is signed in
      if (isLoginPage) {
        window.location.href = 'chat.html';
      } else {
        // Update online status
        try {
          await db.collection('users').doc(user.uid).update({
            online: true,
            lastSeen: firebase.firestore.FieldValue.serverTimestamp()
          });
        } catch (e) {
          console.warn('[Auth] Could not update online status:', e);
        }

        // Set offline on disconnect (via beforeunload)
        window.addEventListener('beforeunload', () => {
          navigator.sendBeacon && db.collection('users').doc(user.uid).update({
            online: false,
            lastSeen: firebase.firestore.FieldValue.serverTimestamp()
          });
        });
      }
    } else {
      // Not signed in
      if (!isLoginPage) {
        window.location.href = 'index.html';
      }
    }
  });

  // ── Login Form Handler ──
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    const phoneInput    = document.getElementById('phoneInput');
    const passwordInput = document.getElementById('passwordInput');
    const loginBtn      = document.getElementById('loginBtn');
    const loginError    = document.getElementById('loginError');
    const togglePwd     = document.getElementById('togglePassword');

    // Toggle password visibility
    if (togglePwd) {
      togglePwd.addEventListener('click', () => {
        const type = passwordInput.type === 'password' ? 'text' : 'password';
        passwordInput.type = type;
        togglePwd.textContent = type === 'password' ? '👁️' : '🙈';
      });
    }

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const phone = phoneInput.value.trim();
      const password = passwordInput.value;

      if (!phone || !password) return;

      // Show loading
      loginBtn.classList.add('loading');
      loginBtn.disabled = true;
      loginError.classList.remove('show');

      try {
        const email = phoneToEmail(phone);
        await auth.signInWithEmailAndPassword(email, password);
        // onAuthStateChanged will handle redirect
      } catch (error) {
        console.error('[Auth] Login error:', error);
        let msg = 'Login failed. Please try again.';

        switch (error.code) {
          case 'auth/user-not-found':
            msg = 'No account found with this phone number.';
            break;
          case 'auth/wrong-password':
          case 'auth/invalid-credential':
            msg = 'Incorrect password. Please try again.';
            break;
          case 'auth/too-many-requests':
            msg = 'Too many attempts. Please wait a moment.';
            break;
          case 'auth/invalid-email':
            msg = 'Invalid phone number format.';
            break;
          case 'auth/network-request-failed':
            msg = 'Network error. Check your connection.';
            break;
        }

        loginError.textContent = msg;
        loginError.classList.add('show');
        loginBtn.classList.remove('loading');
        loginBtn.disabled = false;
      }
    });
  }

  // ── Logout Function (global) ──
  window.logoutUser = async function () {
    try {
      const user = auth.currentUser;
      if (user) {
        await db.collection('users').doc(user.uid).update({
          online: false,
          lastSeen: firebase.firestore.FieldValue.serverTimestamp()
        });
      }
      await auth.signOut();
      window.location.href = 'index.html';
    } catch (error) {
      console.error('[Auth] Logout error:', error);
    }
  };

  // ── Helper: get current user info ──
  window.getCurrentUser = function () {
    const user = auth.currentUser;
    if (!user) return null;
    return {
      uid: user.uid,
      email: user.email,
      phone: emailToPhone(user.email)
    };
  };

  // ── Helper: phone to email (global) ──
  window.phoneToEmail = phoneToEmail;
  window.emailToPhone = emailToPhone;

})();
