// ============================================================
// Main Application Bootstrap & Event Router
// Wires together authentication state, background workers,
// UI drawers, custom theme selectors, and audio/video calls.
// ============================================================

(function () {
  'use strict';

  const getCurrentChatId = () => window.getCurrentChatId ? window.getCurrentChatId() : null;
  const getCurrentUser = () => window.getCurrentUser ? window.getCurrentUser() : null;
  const getCachedContacts = () => window.getCachedContacts ? window.getCachedContacts() : [];
  const showToast = (msg, type) => window.showToast ? window.showToast(msg, type) : console.log(msg);
  const openChat = (contact) => window.openChat ? window.openChat(contact) : null;
  const filterContacts = () => window.filterContacts ? window.filterContacts() : null;

  let currentRotation = 0;

  // Wait for authentication state before booting
  auth.onAuthStateChanged((user) => {
    if (!user) return; // Auth module handles signout redirect

    initApp(user);
  });

  function initApp(user) {
    console.log('[App] Bootstrapping chat services for:', user.email);

    const phone = emailToPhone(user.email);
    const initials = getInitials(phone);

    // Initial sidebar indicators
    document.getElementById('myAvatar').textContent = initials;
    document.getElementById('myName').textContent = phone;

    // Load active contacts list
    loadContacts();

    // Register call signal listeners
    initCallListener();

    // Setup background push notifications
    registerPushNotifications(user);

    // Setup custom theme presets from localStorage
    applyUserSavedTheme();

    // Populate drawer values
    loadProfileDetails(user.uid);

    // Initialize Emoji Keyboard
    renderEmojiGrid();

    // ── Bind UI Click Events ──

    // Mobile: back button returns to list view
    document.getElementById('backBtn').addEventListener('click', () => {
      document.getElementById('sidebar').classList.remove('hidden');
    });

    // Global Contacts search input query debounce
    document.getElementById('searchContacts').addEventListener('input', () => {
      filterContacts();
    });

    // Message composer auto resize & key bounds
    const msgInput = document.getElementById('messageInput');
    const toggleComposerButtons = () => {
      const hasText = msgInput.value.trim().length > 0;
    const sendBtn = document.getElementById('sendBtn');
    const micBtn = document.getElementById('micBtn');
    if (sendBtn && micBtn) {
        const hasFiles = window.getPendingFiles ? window.getPendingFiles().length > 0 : false;
        if (hasText || hasFiles) {
          sendBtn.classList.remove('hidden');
          micBtn.classList.add('hidden');
        } else {
          sendBtn.classList.add('hidden');
          micBtn.classList.remove('hidden');
        }
      }
    };
    window._toggleComposerButtons = toggleComposerButtons;

    msgInput.addEventListener('input', () => {
      msgInput.style.height = 'auto';
      msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';

      // Save draft text
      const currentChatId = getCurrentChatId();
      if (currentChatId) {
        localStorage.setItem(`draft_${currentChatId}`, msgInput.value);
      }

      toggleComposerButtons();

      // Send typing status signal
      handleTyping();
    });

    msgInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    // Send click buttons mousedown overrides to prevent textarea focus losses
    const sendBtn = document.getElementById('sendBtn');
    let lastTouchSendAt = 0;
    sendBtn.addEventListener('mousedown', (e) => e.preventDefault());
    sendBtn.addEventListener('touchend', (e) => {
      e.preventDefault();
      lastTouchSendAt = Date.now();
      handleSend();
    }, { passive: false });
    sendBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (Date.now() - lastTouchSendAt < 700) return;
      handleSend();
    });

    // Attach File events
    document.getElementById('attachBtn').addEventListener('mousedown', (e) => e.preventDefault());
    document.getElementById('attachBtn').addEventListener('click', () => {
      document.getElementById('fileInput').click();
    });

    document.getElementById('cameraBtn').addEventListener('mousedown', (e) => e.preventDefault());
    document.getElementById('cameraBtn').addEventListener('click', () => {
      document.getElementById('cameraInput').click();
    });

    document.getElementById('fileInput').addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        addPendingFiles(e.target.files);
        toggleComposerButtons();
        e.target.value = '';
      }
    });

    document.getElementById('cameraInput').addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        addPendingFiles(e.target.files);
        toggleComposerButtons();
        e.target.value = '';
      }
    });

    // File attachments Drag & Drop support
    const chatMain = document.getElementById('chatMain');
    chatMain.addEventListener('dragover', (e) => {
      e.preventDefault();
      chatMain.style.outline = '3px dashed var(--accent-solid)';
      chatMain.style.outlineOffset = '-6px';
    });

    ['dragleave', 'drop'].forEach(evt => {
      chatMain.addEventListener(evt, () => {
        chatMain.style.outline = 'none';
      });
    });

    chatMain.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer.files.length > 0 && getCurrentChatId()) {
        addPendingFiles(e.dataTransfer.files);
        toggleComposerButtons();
      }
    });

    // Audio/Video peer call signals
    document.getElementById('audioCallBtn').addEventListener('click', () => {
      makeCall('audio');
    });

    document.getElementById('videoCallBtn').addEventListener('click', () => {
      makeCall('video');
    });

    ['endCallBtn', 'vEndCallBtn'].forEach(id => {
      document.getElementById(id).addEventListener('click', endCall);
    });

    ['toggleMuteBtn', 'vToggleMuteBtn'].forEach(id => {
      document.getElementById(id).addEventListener('click', toggleMute);
    });

    ['toggleCamBtn', 'vToggleCamBtn'].forEach(id => {
      document.getElementById(id).addEventListener('click', toggleCamera);
    });

    // Close reply strip
    document.getElementById('closeReplyBtn').addEventListener('click', () => {
      window.clearReply();
    });

    // Lightbox overlays close
    document.getElementById('closeLightbox').addEventListener('click', () => {
      document.getElementById('lightbox').classList.remove('show');
    });

    document.getElementById('lightbox').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        document.getElementById('lightbox').classList.remove('show');
      }
    });

    // Keyboard bindings (Esc cancels modals/popups)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.getElementById('lightbox').classList.remove('show');
        closeDrawer('profileDrawer');
        closeDrawer('groupDrawer');
        closeDrawer('settingsDrawer');
        closeDrawer('analyticsDrawer');
      }
    });

    // Profile photos inputs change listeners
    document.getElementById('avatarPhotoInput').addEventListener('change', (e) => {
      uploadProfileImage(e.target.files[0], 'avatar');
    });

    document.getElementById('coverPhotoInput').addEventListener('change', (e) => {
      uploadProfileImage(e.target.files[0], 'cover');
    });

    // Set Group Participant loader on drawer open
    document.getElementById('btnNewGroup').addEventListener('click', () => {
      loadGroupParticipantsCheckboxes();
    });

    // Setup VisualViewport API keyboard layout adjustment
    if (window.visualViewport) {
      const chatApp = document.getElementById('chatApp');
      const handleViewportChange = () => {
        chatApp.style.height = `${window.visualViewport.height}px`;
        if (window.scrollMessagesToBottom) {
          window.scrollMessagesToBottom(true);
        }
      };
      window.visualViewport.addEventListener('resize', handleViewportChange);
      window.visualViewport.addEventListener('scroll', handleViewportChange);
      handleViewportChange();
    }

    // Setup Swipe-to-reply gesture event delegation
    const messagesArea = document.getElementById('messagesArea');
    if (messagesArea) {
      let touchStartX = 0;
      let touchStartY = 0;
      let activeSwipeBubble = null;
      let swipeDiffX = 0;
      let isSwiping = false;
      let longPressTimer = null;

      messagesArea.addEventListener('touchstart', (e) => {
        const bubble = e.target.closest('.message-bubble');
        if (!bubble) return;

        const msgDiv = bubble.closest('.message');
        if (msgDiv && msgDiv.querySelector('.italicized')) return; // Ignore deleted messages

        // Long press trigger (600ms hold)
        longPressTimer = setTimeout(() => {
          const msgId = msgDiv.dataset.msgId;
          const isSent = msgDiv.classList.contains('sent');
          const touch = e.touches[0];

          const mockEvent = {
            preventDefault: () => {},
            clientX: touch.clientX,
            clientY: touch.clientY
          };

          if (window.openMessageContextMenu) {
            window.openMessageContextMenu(mockEvent, msgId, isSent, '');
          }
          longPressTimer = null;
        }, 600);

        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        activeSwipeBubble = bubble;
        swipeDiffX = 0;
        isSwiping = false;
      }, { passive: true });

      messagesArea.addEventListener('touchmove', (e) => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }

        if (!activeSwipeBubble) return;

        const currentX = e.touches[0].clientX;
        const currentY = e.touches[0].clientY;
        const diffX = currentX - touchStartX;
        const diffY = currentY - touchStartY;

        // Swiping right with horizontal dominance
        if (diffX > 0 && Math.abs(diffX) > Math.abs(diffY) * 1.5) {
          if (diffX > 10) {
            isSwiping = true;
            swipeDiffX = Math.min(diffX, 80); // Limit translate path
            activeSwipeBubble.style.transform = `translateX(${swipeDiffX}px)`;
            activeSwipeBubble.style.transition = 'none';
          }
        }
      }, { passive: false });

      messagesArea.addEventListener('touchend', () => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }

        if (!activeSwipeBubble) return;

        const bubble = activeSwipeBubble;
        const diffX = swipeDiffX;

        activeSwipeBubble = null;
        swipeDiffX = 0;

        if (isSwiping) {
          bubble.style.transition = 'transform 0.2s cubic-bezier(0.1, 0.8, 0.3, 1)';
          bubble.style.transform = 'translateX(0)';

          if (diffX >= 50) {
            const msgDiv = bubble.closest('.message');
            const msgId = msgDiv.dataset.msgId;
            const isSent = msgDiv.classList.contains('sent');
            const textEl = bubble.querySelector('.message-text');
            const text = textEl ? textEl.textContent : '[Attachment]';
            const senderId = isSent ? user.uid : (window._currentContact ? window._currentContact.uid : '');

            if (msgId && window.triggerReply) {
              window.triggerReply(msgId, senderId, text);
            }
          }
        }
      }, { passive: true });
    }

    console.log('[App] Bootstrapped successfully!');
  }

  // ── Send Action Router ──
  async function handleSend() {
    const msgInput = document.getElementById('messageInput');
    const text = msgInput.value.trim();
    const files = window.getPendingFiles ? window.getPendingFiles() : [];

    if (!text && files.length === 0) return;

    const chatId = window.getCurrentChatId ? window.getCurrentChatId() : null;
    if (!chatId) {
      if (window.showToast) window.showToast('Select a conversation to start messaging', 'error');
      return;
    }

    if (!window.sendMessage) return;
    const sent = await window.sendMessage(text, files);
    if (!sent) {
      msgInput.focus({ preventScroll: true });
      return;
    }

    // Reset inputs and cache draft
    msgInput.value = '';
    msgInput.style.height = 'auto';
    if (window.clearPendingFiles) {
      window.clearPendingFiles();
    }

    localStorage.removeItem(`draft_${chatId}`);

    if (window._toggleComposerButtons) {
      window._toggleComposerButtons();
    }

    // Refocus synchronously to preserve soft keyboard
    requestAnimationFrame(() => msgInput.focus({ preventScroll: true }));
  }

  // ── Register Service Worker & FCM ──
  function registerPushNotifications(user) {
    if (!('serviceWorker' in navigator) || !messaging || !('Notification' in window)) {
      console.warn('[FCM] Push notifications are not supported in this browser');
      return;
    }

      navigator.serviceWorker.register('firebase-messaging-sw.js')
        .then((registration) => {
          console.log('[FCM] ServiceWorker registered with scope:', registration.scope);

          // Request permissions and fetch registration token
          Notification.requestPermission().then((permission) => {
            if (permission === 'granted') {
              messaging.getToken({
                vapidKey: FCM_VAPID_KEY,
                serviceWorkerRegistration: registration
              }).then((token) => {
                if (token) {
                  const sessionId = window.getCurrentSessionId ? window.getCurrentSessionId() : 'default';
                  db.collection('users').doc(user.uid).set({
                    fcmToken: token,
                    notificationPermission: permission,
                    [`fcmTokens.${sessionId}`]: token,
                    fcmTokenUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
                  }, { merge: true });
                }
              }).catch((e) => {
                console.warn('[FCM] Token request failed:', e);
              });
            } else {
              db.collection('users').doc(user.uid).set({
                notificationPermission: permission
              }, { merge: true }).catch(() => {});
            }
          });
        }).catch((err) => {
          console.error('[SW] ServiceWorker registration failed:', err);
        });

      messaging.onMessage((payload) => {
        const title = payload.notification?.title || 'New message';
        const body = payload.notification?.body || 'You received a new message.';
        showToast(`${title}: ${body}`, 'info');
        document.getElementById('msgNotificationSound')?.play().catch(() => {});
      });

      // Listen for message events coming from Service Worker
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.action === 'open_chat') {
          // Open target conversation
          const chatId = event.data.chatId;
          const match = getCachedContacts().find(c => c.chatId === chatId);
          if (match) {
            openChat(match);
          }
        }
      });
  }

  // ── Custom theme presets application ──
  function applyUserSavedTheme() {
    const saved = localStorage.getItem('chatvibe_theme') || 'dark';
    document.body.setAttribute('data-theme', saved);
    const selector = document.getElementById('themeSelector');
    if (selector) selector.value = saved;
  }

  // ── Populate active Profile values ──
  function loadProfileDetails(uid) {
    db.collection('users').doc(uid).onSnapshot((doc) => {
      if (!doc.exists) return;
      const data = doc.data();

      document.getElementById('profileDisplayName').value = data.displayName || '';
      document.getElementById('profileUsername').value = data.username || '';
      document.getElementById('profileBio').value = data.bio || '';

      const privacySeen = document.getElementById('privacyHideLastSeen');
      const privacyRead = document.getElementById('privacyHideReadReceipts');
      if (privacySeen && data.privacySettings) privacySeen.checked = data.privacySettings.hideLastSeen || false;
      if (privacyRead && data.privacySettings) privacyRead.checked = data.privacySettings.hideReadReceipts || false;

      // Update avatars in drawer
      const initials = getInitials(data.displayName || data.phoneNumber);
      const drawerAvatar = document.getElementById('myDrawerAvatar');
      drawerAvatar.textContent = data.profilePic ? '' : initials;
      if (data.profilePic) {
        drawerAvatar.style.backgroundImage = `url(${data.profilePic})`;
        drawerAvatar.style.backgroundSize = 'cover';
        drawerAvatar.style.color = 'transparent';
      }

      if (data.coverPhoto) {
        document.getElementById('myCoverPhoto').src = data.coverPhoto;
      }
    });
  }

  // Save profile changes to Firestore
  window.saveUserProfile = async function () {
    const user = auth.currentUser;
    if (!user) return;

    const name = document.getElementById('profileDisplayName').value.trim();
    const username = document.getElementById('profileUsername').value.trim();
    const bio = document.getElementById('profileBio').value.trim();
    const hideSeen = document.getElementById('privacyHideLastSeen').checked;
    const hideRead = document.getElementById('privacyHideReadReceipts').checked;

    if (!name) {
      showToast('Display Name is required', 'warning');
      return;
    }

    try {
      await db.collection('users').doc(user.uid).update({
        displayName: name,
        username: username.startsWith('@') ? username : '@' + username,
        bio: bio,
        privacySettings: { hideLastSeen: hideSeen, hideReadReceipts: hideRead }
      });
      showToast('Profile updated successfully', 'success');
      closeDrawer('profileDrawer');
    } catch (e) {
      showToast('Could not update profile', 'error');
    }
  };

  // Profile and cover uploads
  async function uploadProfileImage(file, target) {
    const user = auth.currentUser;
    if (!user || !file) return;

    if (!file.type.startsWith('image/')) {
      showToast('Only image files are allowed', 'warning');
      return;
    }

    showToast(`Uploading ${target}...`, 'info');
    try {
      // Path: /profiles/{uid}/{target}.jpg
      const path = `profiles/${user.uid}/${target}_${Date.now()}_${file.name}`;
      const ref = storage.ref(path);

      const uploadTask = await ref.put(file);
      const url = await uploadTask.ref.getDownloadURL();

      const userRef = db.collection('users').doc(user.uid);
      if (target === 'avatar') {
        await userRef.update({ profilePic: url });
      } else {
        await userRef.update({ coverPhoto: url });
      }
      showToast(`${target} updated successfully`, 'success');
    } catch (e) {
      console.error('[Profile] Image Upload error:', e);
      showToast('Image upload failed', 'error');
    }
  }

  // Load contact checkboxes for Group builder drawer
  function loadGroupParticipantsCheckboxes() {
    const list = document.getElementById('groupParticipantList');
    list.innerHTML = '';

    const directContacts = getCachedContacts().filter(c => !c.isGroup);
    if (directContacts.length === 0) {
      list.innerHTML = '<div class="empty-text">No contacts found</div>';
      return;
    }

    directContacts.forEach(c => {
      const item = document.createElement('div');
      item.className = 'participant-item';
      item.innerHTML = `
        <div class="participant-item-left">
          <div class="participant-avatar">${getInitials(c.displayName)}</div>
          <span class="participant-name">${c.displayName}</span>
        </div>
        <input type="checkbox" class="group-participant-check" value="${c.uid}" style="width:18px;height:18px;">
      `;
      list.appendChild(item);
    });
  }

  // ── Modern Emoji keyboard picker ──
  function renderEmojiGrid() {
    const picker = document.getElementById('emojiPickerDrawer');
    const emojisList = ["😀","😃","😄","😁","😆","😅","😂","🤣","😊","😇","🙂","🙃","😉","😌","😍","🥰","😘","😗","😙","😚","😋","😛","😝","😜","🤪","🤨","🧐","🤓","😎","🤩","🥳","😏","😒","😞","😔","😟","😕","🙁","☹️","😣","😖","😫","😩","🥺","😢","😭","😤","😠","😡","🤬","🤯","😳","🥵","🥶","😱","😨","😰","😥","😓","🤗","🤔","🤭","🤫","🤥","😶","😐","😑","😬","🙄","😯","😦","😧","😮","😲","🥱","😴","🤤","😪","😵","🤐","🥴","🤢","🤮","🤧","😷","🤒","🤕","🤑","🤠","😈","👿","👹","👺","🤡","💩","👻","💀","☠️","👽","👾","🤖","🎃","😺","😸","😹","😻","😼","😽","🙀","😿","😾","👋","🤚","🖐️","✋","🖖","👌","🤏","✌️","🤞","🤟","🤘","🤙","👈","👉","👆","🖕","👇","☝️","👍","👎","✊","👊","🤛","🤜","👏","🙌","👐","🤲","🤝","🙏","✍️","💅","🤳","💪","🦾","🦵","🦿","🦶","👂","🦻","👃","🧠","🦷","🦴","👀","👁️","👅","👄","💋","🩸","❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💞","💓","💗","💖","💘","💝","💟"];

    picker.innerHTML = `
      <div class="emoji-picker-header">Frequently Used Emojis</div>
      <div class="emoji-grid">
        ${emojisList.map(e => `<span onclick="insertEmojiCharacter('${e}')">${e}</span>`).join('')}
      </div>
    `;
  }

  window.toggleEmojiPicker = function () {
    document.getElementById('emojiPickerDrawer').classList.toggle('show');
  };

  window.insertEmojiCharacter = function (emoji) {
    const input = document.getElementById('messageInput');
    input.value += emoji;
    input.focus({ preventScroll: true });
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // Auto-resize composer area
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    if (window._toggleComposerButtons) {
      window._toggleComposerButtons();
    }
    if (window.handleTyping) {
      window.handleTyping();
    }
  };

  // ── Lightbox rotations and downloads ──
  window.rotateLightboxImage = function (degrees) {
    currentRotation = (currentRotation + degrees) % 360;
    document.getElementById('lightboxImg').style.transform = `rotate(${currentRotation}deg)`;
  };

  window.downloadLightboxImage = function () {
    const url = document.getElementById('lightboxImg').src;
    if (!url) return;

    // Direct download trigger
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.download = `chatvibe_media_${Date.now()}`;
    link.click();
    showToast('Download started', 'success');
  };

  // Open mentioned user profile popup
  window.openMentionedProfile = function (phone) {
    const match = getCachedContacts().find(c => c.phoneNumber === phone);
    if (match) {
      openChat(match);
    } else {
      showToast('Contact is not in your chat list', 'info');
    }
  };

  // Clear lightbox rotation when opened
  const originalOpenLightbox = window.openLightbox;
  window.openLightbox = function (url) {
    currentRotation = 0;
    const img = document.getElementById('lightboxImg');
    if (img) img.style.transform = 'rotate(0deg)';

    if (originalOpenLightbox) {
      originalOpenLightbox(url);
    } else {
      img.src = url;
      document.getElementById('lightbox').classList.add('show');
    }
  };

})();
