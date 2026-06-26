// ============================================================
// App Controller
// Main application bootstrap and event wiring for chat.html.
// Ties together auth, chat, file-upload, and calls modules.
// ============================================================

(function () {
  'use strict';

  // Wait for auth state before initializing
  auth.onAuthStateChanged((user) => {
    if (!user) return; // auth.js handles redirect

    initApp(user);
  });

  function initApp(user) {
    console.log('[App] Initializing for:', user.email);

    const phone = emailToPhone(user.email);
    const initials = getInitials(phone);

    // Set sidebar user info
    document.getElementById('myAvatar').textContent = initials;
    document.getElementById('myName').textContent = phone;

    // Load contacts
    loadContacts();

    // Init call listener
    initCallListener();

    // ── Event Bindings ──

    // Back button (mobile)
    document.getElementById('backBtn').addEventListener('click', () => {
      document.getElementById('sidebar').classList.remove('hidden');
    });

    // Search contacts (client-side filtering)
    document.getElementById('searchContacts').addEventListener('input', () => {
      filterContacts();
    });

    // Message input — auto-resize + typing indicator
    const msgInput = document.getElementById('messageInput');
    msgInput.addEventListener('input', () => {
      // Auto-resize
      msgInput.style.height = 'auto';
      msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';

      // Typing indicator
      handleTyping();
    });

    // Send message on Enter (Shift+Enter for new line)
    msgInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    // Send button
    document.getElementById('sendBtn').addEventListener('click', handleSend);

    // File attach button
    document.getElementById('attachBtn').addEventListener('click', () => {
      document.getElementById('fileInput').click();
    });

    // Camera button
    document.getElementById('cameraBtn').addEventListener('click', () => {
      document.getElementById('cameraInput').click();
    });

    // File input change
    document.getElementById('fileInput').addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        addPendingFiles(e.target.files);
        e.target.value = ''; // Reset
      }
    });

    // Camera input change
    document.getElementById('cameraInput').addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        addPendingFiles(e.target.files);
        e.target.value = '';
      }
    });

    // Drag and drop on messages area
    const chatMain = document.getElementById('chatMain');
    chatMain.addEventListener('dragover', (e) => {
      e.preventDefault();
      chatMain.style.outline = '2px dashed var(--accent-solid)';
      chatMain.style.outlineOffset = '-4px';
    });

    chatMain.addEventListener('dragleave', () => {
      chatMain.style.outline = 'none';
    });

    chatMain.addEventListener('drop', (e) => {
      e.preventDefault();
      chatMain.style.outline = 'none';
      if (e.dataTransfer.files.length > 0 && getCurrentChatId()) {
        addPendingFiles(e.dataTransfer.files);
      }
    });

    // Audio call button
    document.getElementById('audioCallBtn').addEventListener('click', () => {
      makeCall('audio');
    });

    // Video call button
    document.getElementById('videoCallBtn').addEventListener('click', () => {
      makeCall('video');
    });

    // Call control buttons — both overlay and video container
    ['endCallBtn', 'vEndCallBtn'].forEach(id => {
      document.getElementById(id).addEventListener('click', endCall);
    });

    ['toggleMuteBtn', 'vToggleMuteBtn'].forEach(id => {
      document.getElementById(id).addEventListener('click', toggleMute);
    });

    ['toggleCamBtn', 'vToggleCamBtn'].forEach(id => {
      document.getElementById(id).addEventListener('click', toggleCamera);
    });

    // Lightbox close
    document.getElementById('closeLightbox').addEventListener('click', () => {
      document.getElementById('lightbox').classList.remove('show');
    });

    document.getElementById('lightbox').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        document.getElementById('lightbox').classList.remove('show');
      }
    });

    // Keyboard shortcut: Escape to close lightbox/call
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.getElementById('lightbox').classList.remove('show');
      }
    });

    console.log('[App] Ready!');
  }

  // ── Handle sending message ──
  function handleSend() {
    const msgInput = document.getElementById('messageInput');
    const text = msgInput.value.trim();
    const files = getPendingFiles();

    if (!text && files.length === 0) return;
    if (!getCurrentChatId()) {
      showToast('Select a contact first', 'error');
      return;
    }

    // Send message
    sendMessage(text, files);

    // Clear input
    msgInput.value = '';
    msgInput.style.height = 'auto';
    clearPendingFiles();
  }

})();
