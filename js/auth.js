// ============================================================
// Authentication & Presence Module
// Handles login, session management, user profile settings,
// and online presence updates.
// ============================================================

(function () {
  'use strict';

  const showToast = (msg, type) => window.showToast ? window.showToast(msg, type) : console.log(msg);

  const EMAIL_DOMAIN = '@chatapp.com';
  let presenceTimer = null;
  let sessionUpdateInterval = null;

  // Convert phone number to email format for Firebase Auth
  function phoneToEmail(phone) {
    const cleaned = phone.replace(/[\s\-\(\)]/g, '');
    return cleaned + EMAIL_DOMAIN;
  }

  // Get phone from email
  function emailToPhone(email) {
    return email.replace(EMAIL_DOMAIN, '');
  }

  // Generate or retrieve a persistent session ID for this browser tab
  function getSessionId() {
    let sid = localStorage.getItem('chatvibe_session_id');
    if (!sid) {
      sid = 'sess_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
      localStorage.setItem('chatvibe_session_id', sid);
    }
    return sid;
  }

  // ── Auth State Listener ──
  auth.onAuthStateChanged(async (user) => {
    const isLoginPage = window.location.pathname === '/' ||
                        window.location.pathname.endsWith('index.html') ||
                        window.location.pathname === '';

    if (user) {
      // User is signed in
      if (isLoginPage) {
        window.location.href = 'chat.html';
      } else {
        // Setup user record and sessions
        await setupUserSession(user);

        // Start presence tracking (away detection)
        startPresenceTracking(user.uid);
      }
    } else {
      // Not signed in
      clearPresenceTracking();
      if (!isLoginPage) {
        window.location.href = 'index.html';
      }
    }
  });

  // Setup user presence & session info in Firestore
  async function setupUserSession(user) {
    const uid = user.uid;
    const phone = emailToPhone(user.email);
    const sessionId = getSessionId();
    const userAgent = navigator.userAgent;

    // Create user doc if not exists, or update it
    const userRef = db.collection('users').doc(uid);
    
    try {
      const doc = await userRef.get();
      if (!doc.exists) {
        await userRef.set({
          phoneNumber: phone,
          displayName: phone,
          username: '@' + phone,
          bio: 'Hey there! I am using ChatVibe.',
          online: true,
          status: 'online',
          lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
          privacySettings: { hideLastSeen: false, hideReadReceipts: false },
          blockedUsers: [],
          deviceSessions: []
        });
      }

      // Add or update active session
      const currentSessions = doc.exists ? (doc.data().deviceSessions || []) : [];
      const updatedSessions = currentSessions.filter(s => s.sessionId !== sessionId);
      updatedSessions.push({
        sessionId: sessionId,
        deviceInfo: parseUserAgent(userAgent),
        lastActive: new Date()
      });

      await userRef.update({
        online: true,
        status: 'online',
        lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
        deviceSessions: updatedSessions
      });

      // Periodic heartbeat keeps presence fresh; stale clients are treated offline by the UI.
      sessionUpdateInterval = setInterval(() => {
        userRef.get().then(d => {
          if (!d.exists) return;
          const sess = d.data().deviceSessions || [];
          const matched = sess.find(s => s.sessionId === sessionId);
          if (matched) {
            matched.lastActive = new Date();
            userRef.update({
              online: true,
              status: document.hidden ? 'away' : 'online',
              lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
              deviceSessions: sess
            });
          }
        });
      }, 30 * 1000);

      // Offline trigger
      const markOffline = () => {
        userRef.update({
          online: false,
          status: 'offline',
          lastSeen: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(() => {});
      };
      window.addEventListener('pagehide', markOffline);
      window.addEventListener('beforeunload', markOffline);

    } catch (e) {
      console.warn('[Auth] Error setting up session:', e);
    }
  }

  // ── Presence Inactivity tracking (Away state) ──
  function startPresenceTracking(uid) {
    const INACTIVITY_LIMIT = 5 * 60 * 1000; // 5 minutes to Away
    const userRef = db.collection('users').doc(uid);

    function resetTimer() {
      // If currently away or busy, keep user updated to active
      userRef.get().then(doc => {
        if (doc.exists && (doc.data().status === 'away' || doc.data().status === 'offline')) {
          userRef.update({ status: 'online', online: true });
        }
      });

      clearTimeout(presenceTimer);
      presenceTimer = setTimeout(() => {
        userRef.update({ status: 'away' }).catch(() => {});
      }, INACTIVITY_LIMIT);
    }

    // Bind interaction events
    ['mousemove', 'keydown', 'click', 'touchstart'].forEach(evt => {
      window.addEventListener(evt, resetTimer);
    });
    resetTimer();
  }

  function clearPresenceTracking() {
    clearTimeout(presenceTimer);
    clearInterval(sessionUpdateInterval);
  }

  // ── Update Display Status manually (online | away | busy) ──
  window.updateMyPresenceStatus = async function (status) {
    const user = auth.currentUser;
    if (!user) return;
    try {
      await db.collection('users').doc(user.uid).update({
        status: status,
        online: status !== 'offline'
      });
      showToast('Status updated to ' + status, 'success');
    } catch (e) {
      showToast('Failed to update status', 'error');
    }
  };

  // ── Parse user agent for human readability ──
  function parseUserAgent(ua) {
    if (ua.includes('Mobi')) {
      if (ua.includes('iPhone')) return 'iOS App / Safari Mobile';
      return 'Android Chrome Mobile';
    }
    if (ua.includes('Chrome')) return 'Chrome Browser (Desktop)';
    if (ua.includes('Firefox')) return 'Firefox Browser (Desktop)';
    if (ua.includes('Safari')) return 'Safari (Desktop)';
    return 'Desktop Client';
  }

  // ── Login Form Handler ──
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    const phoneInput    = document.getElementById('phoneInput');
    const passwordInput = document.getElementById('passwordInput');
    const loginBtn      = document.getElementById('loginBtn');
    const loginError    = document.getElementById('loginError');
    const togglePwd     = document.getElementById('togglePassword');

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

      loginBtn.classList.add('loading');
      loginBtn.disabled = true;
      loginError.classList.remove('show');

      try {
        const email = phoneToEmail(phone);
        await auth.signInWithEmailAndPassword(email, password);
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

  // ── Logout Function ──
  window.logoutUser = async function () {
    try {
      const user = auth.currentUser;
      if (user) {
        const sessionId = getSessionId();
        const userRef = db.collection('users').doc(user.uid);
        const doc = await userRef.get();
        if (doc.exists) {
          const sessions = doc.data().deviceSessions || [];
          const updated = sessions.filter(s => s.sessionId !== sessionId);
          await userRef.update({
            online: false,
            status: 'offline',
            lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
            deviceSessions: updated
          });
        }
      }
      clearPresenceTracking();
      await auth.signOut();
      window.location.href = 'index.html';
    } catch (error) {
      console.error('[Auth] Logout error:', error);
    }
  };

  // ── Global Helper: getCurrentUser ──
  window.getCurrentUser = function () {
    const user = auth.currentUser;
    if (!user) return null;
    return {
      uid: user.uid,
      email: user.email,
      phone: emailToPhone(user.email)
    };
  };

  // ── Revoke device session ──
  window.revokeDeviceSession = async function (targetSessionId) {
    const user = auth.currentUser;
    if (!user) return;
    try {
      const userRef = db.collection('users').doc(user.uid);
      const doc = await userRef.get();
      if (doc.exists) {
        const sessions = doc.data().deviceSessions || [];
        const filtered = sessions.filter(s => s.sessionId !== targetSessionId);
        await userRef.update({ deviceSessions: filtered });
        showToast('Device session revoked', 'success');
        // If current session was revoked, force logout
        if (targetSessionId === getSessionId()) {
          logoutUser();
        } else {
          // Refresh UI
          if (window.renderSettingsDrawer) window.renderSettingsDrawer();
        }
      }
    } catch (e) {
      showToast('Could not revoke session', 'error');
    }
  };

  // Expose helpers globally
  window.phoneToEmail = phoneToEmail;
  window.emailToPhone = emailToPhone;
  window.getCurrentSessionId = getSessionId;

})();
