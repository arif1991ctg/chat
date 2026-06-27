// ============================================================
// Core Chat Module
// Handles real-time messaging, paginated Firestore fetching,
// typing/recording, seen status receipts, group chat actions,
// and message interactions.
// ============================================================

(function () {
  'use strict';

  const showToast = (msg, type) => window.showToast ? window.showToast(msg, type) : console.log(msg);

  // ── State ──
  let currentChatId = null;
  let currentContactUid = null;
  let messagesUnsubscribe = null;
  let typingTimeout = null;
  let contactsUnsubscribe = null;
  let chatsUnsubscribe = null;
  let activeContactStatusUnsubscribe = null;
  let activeChatDetailsUnsubscribe = null;
  let typingUnsubscribe = null;
  const lastMessageUnsubscribers = new Map();
  const unreadUnsubscribers = new Map();
  let lastDateShown = null;

  // Pagination & Lazy loading state
  let messagesLimit = 30;
  let allMessagesLoaded = false;
  let firstVisibleDoc = null;
  let preventScrollJump = false;

  // Custom states
  let activeChatFilter = 'all'; // 'all' | 'groups' | 'archived' | 'favorites'
  let cachedContacts = [];
  let pendingMessageQueue = [];
  let activeChatDetails = null; // Current chat document data
  let flushInProgress = false;
  const PRESENCE_STALE_MS = 90 * 1000;

  // Audio Playbacks speed mapping
  let voiceSpeedRates = {}; // map of [msgId]: speedMultiplier

  // ── Connection Indicator ──
  window.addEventListener('online', () => {
    document.getElementById('offlineBanner').classList.remove('show');
    flushPendingMessageQueue();
  });
  window.addEventListener('offline', () => {
    document.getElementById('offlineBanner').classList.add('show');
  });

  // Track Firestore Read counts in localStorage
  function incrementFirestoreReads(count = 1) {
    let current = parseInt(localStorage.getItem('chatvibe_analytics_reads') || '0');
    current += count;
    localStorage.setItem('chatvibe_analytics_reads', current.toString());
    updateAnalyticsDashboard();
  }

  function getChatId(uid1, uid2) {
    return [uid1, uid2].sort().join('_');
  }

  function getQueueStorageKey() {
    const user = getCurrentUser();
    return user ? `chatvibe_pending_messages_${user.uid}` : 'chatvibe_pending_messages';
  }

  function restorePendingMessageQueue() {
    try {
      pendingMessageQueue = JSON.parse(localStorage.getItem(getQueueStorageKey()) || '[]');
    } catch (e) {
      pendingMessageQueue = [];
    }
  }

  function persistPendingMessageQueue() {
    localStorage.setItem(getQueueStorageKey(), JSON.stringify(pendingMessageQueue));
  }

  function createClientMessageId(userId) {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function cleanupActiveChatListeners() {
    if (messagesUnsubscribe) {
      messagesUnsubscribe();
      messagesUnsubscribe = null;
    }
    if (activeContactStatusUnsubscribe) {
      activeContactStatusUnsubscribe();
      activeContactStatusUnsubscribe = null;
    }
    if (activeChatDetailsUnsubscribe) {
      activeChatDetailsUnsubscribe();
      activeChatDetailsUnsubscribe = null;
    }
    if (typingUnsubscribe) {
      typingUnsubscribe();
      typingUnsubscribe = null;
    }
  }

  function getInitials(phone) {
    if (!phone) return '?';
    const digits = phone.replace(/\D/g, '');
    return digits.slice(-2) || phone.substr(0, 2).toUpperCase();
  }

  function formatTime(timestamp) {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatDate(timestamp) {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function formatLastSeen(timestamp, privacySettings) {
    // Check privacy settings
    if (privacySettings && privacySettings.hideLastSeen) {
      return 'Offline';
    }
    if (!timestamp) return 'Offline';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const now = new Date();
    const diff = (now - date) / 1000;

    if (diff < 60) return 'last seen just now';
    if (diff < 3600) return `last seen ${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `last seen ${Math.floor(diff / 3600)}h ago`;
    return 'last seen ' + date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function getMillis(timestamp) {
    if (!timestamp) return 0;
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const millis = date.getTime();
    return Number.isNaN(millis) ? 0 : millis;
  }

  function isFreshPresence(userData) {
    if (!userData || userData.online !== true) return false;
    return Date.now() - getMillis(userData.lastSeen) < PRESENCE_STALE_MS;
  }

  function updateActiveContactStatus(data) {
    const statusEl = document.getElementById('chatStatus');
    if (!statusEl || !data) return;

    if (data.isGroup) {
      statusEl.textContent = 'Group Conversation';
      statusEl.classList.remove('online');
      return;
    }

    const visibleOnline = isFreshPresence(data) && (!data.privacySettings || !data.privacySettings.hideLastSeen);
    if (visibleOnline) {
      if (data.status === 'away') {
        statusEl.textContent = 'Away';
      } else if (data.status === 'busy') {
        statusEl.textContent = 'Busy';
      } else {
        statusEl.textContent = 'Online';
      }
      statusEl.className = 'header-status online';
    } else {
      statusEl.textContent = formatLastSeen(data.lastSeen, data.privacySettings);
      statusEl.classList.remove('online');
    }
  }

  function refreshPresenceIndicators() {
    cachedContacts.forEach((chat) => {
      if (chat.isGroup) return;
      const dot = document.querySelector(`.contact-item[data-uid="${chat.uid}"] .status-dot`);
      if (!dot) return;
      dot.className = 'status-dot offline';
      if (isFreshPresence(chat) && (!chat.privacySettings || !chat.privacySettings.hideLastSeen)) {
        dot.classList.remove('offline');
        dot.classList.add(chat.status === 'away' ? 'away' : (chat.status === 'busy' ? 'busy' : 'online'));
      }
    });

    if (window._currentContact) {
      updateActiveContactStatus(window._currentContact);
    }
    updateAnalyticsDashboard();
  }

  setInterval(refreshPresenceIndicators, 30 * 1000);

  async function ensureConversationReady(chatId, contact) {
    const user = getCurrentUser();
    if (!user || !chatId) return false;

    const chatData = {
      participants: firebase.firestore.FieldValue.arrayUnion(user.uid),
      lastMessageTime: firebase.firestore.FieldValue.serverTimestamp()
    };

    if (contact && !contact.isGroup && contact.uid) {
      chatData.participants = firebase.firestore.FieldValue.arrayUnion(user.uid, contact.uid);
      chatData.isGroup = false;
    }

    await db.collection('chats').doc(chatId).set(chatData, { merge: true });
    return true;
  }

  // ── Load contacts and conversations (unified list) ──
  window.loadContacts = function () {
    const user = getCurrentUser();
    if (!user) return;

    if (contactsUnsubscribe) return; // Already listening

    // Listen to users
    contactsUnsubscribe = db.collection('users')
      .onSnapshot(async (snapshot) => {
        incrementFirestoreReads(snapshot.size);
        const contactMap = new Map();
        snapshot.forEach((doc) => {
          const data = { uid: doc.id, ...doc.data() };
          if (doc.id === user.uid) {
            // Update my local storage details
            window._myDetails = data;
            return;
          }
          contactMap.set(doc.id, data);
        });

        if (chatsUnsubscribe) {
          chatsUnsubscribe();
          chatsUnsubscribe = null;
        }

        // Listen to groups and DMs that current user is a participant of
        chatsUnsubscribe = db.collection('chats')
          .where('participants', 'array-contains', user.uid)
          .onSnapshot((chatSnapshot) => {
            incrementFirestoreReads(chatSnapshot.size);
            const chatsList = [];

            chatSnapshot.forEach((doc) => {
              const data = { chatId: doc.id, ...doc.data() };

              if (data.isGroup) {
                // Group chat object
                chatsList.push({
                  uid: doc.id,
                  chatId: doc.id,
                  displayName: data.name,
                  phoneNumber: 'Group Chat',
                  isGroup: true,
                  avatar: data.avatar,
                  ...data
                });
              } else {
                // DM chat object
                const otherUid = data.participants.find(p => p !== user.uid);
                const otherUser = contactMap.get(otherUid);
                if (otherUser) {
                  chatsList.push({
                    uid: otherUid,
                    chatId: doc.id,
                    isGroup: false,
                    displayName: otherUser.displayName || otherUser.phoneNumber,
                    phoneNumber: otherUser.phoneNumber,
                    online: otherUser.online,
                    status: otherUser.status,
                    lastSeen: otherUser.lastSeen,
                    privacySettings: otherUser.privacySettings,
                    blockedUsers: otherUser.blockedUsers,
                    ...data
                  });
                }
              }
            });

            // Merge individual contacts who don't have conversations yet
            contactMap.forEach((u) => {
              const hasChat = chatsList.some(c => !c.isGroup && c.uid === u.uid);
              if (!hasChat) {
                chatsList.push({
                  uid: u.uid,
                  chatId: getChatId(user.uid, u.uid),
                  isGroup: false,
                  displayName: u.displayName || u.phoneNumber,
                  phoneNumber: u.phoneNumber,
                  online: u.online,
                  status: u.status,
                  lastSeen: u.lastSeen,
                  privacySettings: u.privacySettings,
                  blockedUsers: u.blockedUsers
                });
              }
            });

            cachedContacts = chatsList;

            // Hide skeleton loading
            document.getElementById('contactsSkeleton')?.classList.add('hidden');
            renderContacts(cachedContacts, user.uid);
            updateAnalyticsDashboard();
          });
      }, (error) => {
        console.error('[Chat] Error loading contacts:', error);
      });
  };

  window.filterContacts = function () {
    const user = getCurrentUser();
    if (!user) return;
    renderContacts(cachedContacts, user.uid);
  };

  // Render contacts with sorting, pinning, archiving, and filters
  function renderContacts(chats, myUid) {
    const contactsList = document.getElementById('contactsList');
    const searchQuery = (document.getElementById('searchContacts')?.value || '').toLowerCase();

    // Clear dynamic list items
    const existingItems = contactsList.querySelectorAll('.contact-item');
    existingItems.forEach(el => el.remove());

    // Filter by Tabs
    let filtered = chats.filter(c => {
      // Archived filter
      const isArchived = c.archivedBy && c.archivedBy[myUid] === true;
      if (activeChatFilter === 'archived') return isArchived;
      if (isArchived) return false; // Hide archived from other lists

      if (activeChatFilter === 'groups') return c.isGroup === true;
      if (activeChatFilter === 'favorites') return c.favoritedBy && c.favoritedBy[myUid] === true;
      return true;
    });

    // Filter by Search Query
    if (searchQuery) {
      filtered = filtered.filter(c =>
        (c.displayName || '').toLowerCase().includes(searchQuery) ||
        (c.phoneNumber || '').toLowerCase().includes(searchQuery) ||
        (c.username || '').toLowerCase().includes(searchQuery)
      );
    }

    // Sort by Pin priority, then latest message time
    filtered.sort((a, b) => {
      const pinA = a.pinnedBy && a.pinnedBy[myUid] === true ? 1 : 0;
      const pinB = b.pinnedBy && b.pinnedBy[myUid] === true ? 1 : 0;
      if (pinA !== pinB) return pinB - pinA; // Pinned stays on top

      const timeA = a.lastMessageTime ? (a.lastMessageTime.toDate ? a.lastMessageTime.toDate() : new Date(a.lastMessageTime)) : 0;
      const timeB = b.lastMessageTime ? (b.lastMessageTime.toDate ? b.lastMessageTime.toDate() : new Date(b.lastMessageTime)) : 0;
      return timeB - timeA;
    });

    if (filtered.length === 0) {
      document.getElementById('contactsEmpty').classList.remove('hidden');
      return;
    }
    document.getElementById('contactsEmpty').classList.add('hidden');

    filtered.forEach((chat) => {
      const item = document.createElement('div');
      item.className = 'contact-item' + (chat.uid === currentContactUid ? ' active' : '');
      item.dataset.uid = chat.uid;
      item.dataset.chatId = chat.chatId;

      const isOnline = !chat.isGroup && isFreshPresence(chat) && (!chat.privacySettings || !chat.privacySettings.hideLastSeen);
      const isAway = isOnline && chat.status === 'away';
      const isBusy = isOnline && chat.status === 'busy';
      const initials = getInitials(chat.displayName);

      let statusDotColor = 'offline';
      if (isOnline) statusDotColor = 'online';
      else if (isAway) statusDotColor = 'away';
      else if (isBusy) statusDotColor = 'busy';

      // Star badge if favorite
      const isFavorite = chat.favoritedBy && chat.favoritedBy[myUid] === true;
      const isPinned = chat.pinnedBy && chat.pinnedBy[myUid] === true;

      item.innerHTML = `
        <div class="contact-avatar" style="${chat.avatar ? `background-image:url(${chat.avatar});background-size:cover;color:transparent;` : ''}">
          ${chat.avatar ? '' : initials}
          <div class="status-dot ${statusDotColor} ${chat.isGroup ? 'hidden' : ''}"></div>
        </div>
        <div class="contact-details">
          <div class="contact-name">
            ${chat.displayName}
            ${isPinned ? '<span class="pinned-badge" title="Pinned conversation">📌</span>' : ''}
            ${isFavorite ? '<span class="favorite-badge" title="Favorite">★</span>' : ''}
          </div>
          <div class="contact-last-msg" id="lastMsg_${chat.chatId}">Loading...</div>
        </div>
        <div class="contact-meta">
          <div class="contact-time" id="lastTime_${chat.chatId}"></div>
          <div class="contact-unread" id="unread_${chat.chatId}"></div>
        </div>
      `;

      item.addEventListener('click', () => {
        if (window.openChat) window.openChat(chat);
      });
      contactsList.appendChild(item);

      // Render previews and unread badges
      loadLastMessage(chat.chatId, myUid);
    });
  }

  function loadLastMessage(chatId, myUid) {
    if (lastMessageUnsubscribers.has(chatId)) {
      lastMessageUnsubscribers.get(chatId)();
      lastMessageUnsubscribers.delete(chatId);
    }

    const unsubscribe = db.collection('chats').doc(chatId).collection('messages')
      .orderBy('createdAt', 'desc')
      .limit(1)
      .onSnapshot((snapshot) => {
        incrementFirestoreReads(snapshot.size);
        const lastMsgEl = document.getElementById('lastMsg_' + chatId);
        const lastTimeEl = document.getElementById('lastTime_' + chatId);
        if (!lastMsgEl) return;

        if (snapshot.empty) {
          lastMsgEl.textContent = 'Start a conversation';
          return;
        }

        const msg = snapshot.docs[0].data();
        if (msg.deleted) {
          lastMsgEl.textContent = '🚫 Message deleted';
        } else if (msg.type === 'image') {
          lastMsgEl.textContent = '📷 Photo';
        } else if (msg.type === 'video') {
          lastMsgEl.textContent = '📹 Video';
        } else if (msg.type === 'voice') {
          lastMsgEl.textContent = '🎵 Voice message';
        } else if (msg.type === 'file') {
          lastMsgEl.textContent = '📎 ' + (msg.fileName || 'File');
        } else {
          lastMsgEl.textContent = msg.text || '';
        }

        if (msg.createdAt) {
          lastTimeEl.textContent = formatTime(msg.createdAt);
        }

        // Real-time unread counts update
        loadUnreadCount(chatId, myUid);
      });

    lastMessageUnsubscribers.set(chatId, unsubscribe);
  }

  function loadUnreadCount(chatId, myUid) {
    if (unreadUnsubscribers.has(chatId)) return;

    const unsubscribe = db.collection('chats').doc(chatId).collection('messages')
      .where('seen', '==', false)
      .onSnapshot((snapshot) => {
        incrementFirestoreReads(snapshot.size);
        const unreadEl = document.getElementById('unread_' + chatId);
        if (!unreadEl) return;

        const count = snapshot.docs.filter(doc => doc.data().senderId !== myUid).length;
        unreadEl.textContent = count > 0 ? count : '';
      });

    unreadUnsubscribers.set(chatId, unsubscribe);
  }

  // ── Open Conversation ──
  window.openChat = async function (contact) {
    const user = getCurrentUser();
    if (!user) return;

    currentContactUid = contact.isGroup ? null : contact.uid;
    currentChatId = contact.chatId;
    window._currentContact = contact;
    restorePendingMessageQueue();
    cleanupActiveChatListeners();

    // Reset pagination state
    messagesLimit = 30;
    allMessagesLoaded = false;
    firstVisibleDoc = null;

    // Render active state
    document.querySelectorAll('.contact-item').forEach(el => {
      el.classList.toggle('active', el.dataset.chatId === currentChatId);
    });

    document.getElementById('noChat').classList.add('hidden');
    document.getElementById('chatHeader').classList.remove('hidden');
    document.getElementById('messagesArea').classList.remove('hidden');
    document.getElementById('messageInputArea').classList.remove('hidden');

    const initials = getInitials(contact.displayName);
    const chatAvatarEl = document.getElementById('chatAvatar');
    chatAvatarEl.textContent = contact.avatar ? '' : initials;
    if (contact.avatar) {
      chatAvatarEl.style.backgroundImage = `url(${contact.avatar})`;
      chatAvatarEl.style.backgroundSize = 'cover';
      chatAvatarEl.style.color = 'transparent';
    } else {
      chatAvatarEl.style.backgroundImage = '';
      chatAvatarEl.style.color = '';
    }

    document.getElementById('chatName').textContent = contact.displayName;

    const statusEl = document.getElementById('chatStatus');
    if (contact.isGroup) {
      statusEl.textContent = 'Group Conversation';
      statusEl.classList.remove('online');
    } else {
      // Dynamic updates for contact status
      activeContactStatusUnsubscribe = db.collection('users').doc(contact.uid).onSnapshot((doc) => {
        incrementFirestoreReads(1);
        if (!doc.exists) return;
        const data = doc.data();

        window._currentContact = { ...window._currentContact, ...data, uid: contact.uid, isGroup: false };
        updateActiveContactStatus(window._currentContact);
      });
    }

    // Toggle scroll container mobile classes
    if (window.innerWidth <= 768) {
      document.getElementById('sidebar').classList.add('hidden');
    }

    // Fetch wallpaper settings
    activeChatDetailsUnsubscribe = db.collection('chats').doc(currentChatId).onSnapshot((doc) => {
      incrementFirestoreReads(1);
      if (!doc.exists) return;
      activeChatDetails = doc.data();

      const userWallpaper = activeChatDetails.wallpaper && activeChatDetails.wallpaper[user.uid];
      const msgsArea = document.getElementById('messagesArea');

      // Clear wallpapers
      msgsArea.className = 'messages-area';
      if (userWallpaper && userWallpaper !== 'default') {
        msgsArea.classList.add('wallpaper-' + userWallpaper);
      }

      // Update favorite, mute button indicators
      const isMuted = activeChatDetails.mutedBy && activeChatDetails.mutedBy[user.uid] === true;
      document.getElementById('muteChatBtn').innerHTML = isMuted ?
        `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.73 21a2 2 0 0 1-3.46 0"></path><path d="M18.63 13A17.89 17.89 0 0 1 18 8"></path><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"></path><path d="M18 8a6 6 0 0 0-9.33-5"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>` :
        `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>`;

      const isFavorite = activeChatDetails.favoritedBy && activeChatDetails.favoritedBy[user.uid] === true;
      document.getElementById('favoriteChatBtn').innerHTML = isFavorite ?
        `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>` :
        `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;
    });

    // Mark conversation participants
    try {
      await ensureConversationReady(currentChatId, contact);
    } catch (error) {
      showToast('Could not prepare this conversation: ' + error.message, 'error');
      return;
    }

    // Start message flow
    loadMessages(currentChatId, user.uid);
    listenForTyping(currentChatId, user.uid);
    setupScrollListener();

    // Restore message draft
    const msgInput = document.getElementById('messageInput');
    if (msgInput) {
      const draft = localStorage.getItem(`draft_${currentChatId}`) || '';
      msgInput.value = draft;
      msgInput.style.height = 'auto';
      if (draft) {
        msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
      }
      if (window._toggleComposerButtons) {
        window._toggleComposerButtons();
      }
    }
  };

  // ── Load messages with real-time syncing & pagination ──
  function loadMessages(chatId, myUid) {
    const messagesArea = document.getElementById('messagesArea');

    messagesArea.innerHTML = `
      <button class="scroll-to-bottom-btn" id="scrollToBottomBtn" onclick="scrollMessagesToBottom(true)" aria-label="Scroll to bottom">
        ↓ <span class="badge" id="scrollUnreadBadge"></span>
      </button>
      <div class="typing-indicator" id="typingIndicator">
        <div class="typing-dots"><span></span><span></span><span></span></div>
      </div>
    `;
    lastDateShown = null;

    subscribeToMessageQuery(chatId, myUid);
  }

  function subscribeToMessageQuery(chatId, myUid) {
    const messagesArea = document.getElementById('messagesArea');
    const typingIndicator = document.getElementById('typingIndicator');

    if (messagesUnsubscribe) {
      messagesUnsubscribe();
      messagesUnsubscribe = null;
    }

    let query = db.collection('chats').doc(chatId).collection('messages')
      .orderBy('createdAt', 'desc')
      .limit(messagesLimit);

    messagesUnsubscribe = query.onSnapshot((snapshot) => {
      incrementFirestoreReads(snapshot.size);

      // Track scroll positions to prevent jumping
      const prevScrollHeight = messagesArea.scrollHeight;
      const prevScrollTop = messagesArea.scrollTop;

      // Keep records of doc identifiers
      if (snapshot.docs.length > 0) {
        firstVisibleDoc = snapshot.docs[snapshot.docs.length - 1];
        if (snapshot.size < messagesLimit) {
          allMessagesLoaded = true;
        }
      } else {
        allMessagesLoaded = true;
      }

      // Read messages in chronological order
      const chronDocs = [...snapshot.docs].reverse();

      chronDocs.forEach((doc) => {
        const msg = { id: doc.id, ...doc.data() };

        // Skip rendering if Deleted For Me (deletedBy is map)
        if (msg.deletedBy && msg.deletedBy[myUid]) {
          const existing = document.querySelector(`[data-msg-id="${msg.id}"]`);
          if (existing) existing.remove();
          return;
        }

        const existing = document.querySelector(`[data-msg-id="${msg.id}"]`);
        if (existing) {
          updateMessageDOM(existing, msg, myUid);
        } else {
          const div = createMessageElement(msg, myUid);
          messagesArea.insertBefore(div, typingIndicator);
        }

        // Receipt seen trigger
        if (msg.senderId !== myUid && !msg.seen) {
          doc.ref.update({
            seen: true,
            seenBy: {
              ...(msg.seenBy || {}),
              [myUid]: firebase.firestore.FieldValue.serverTimestamp()
            }
          }).catch(err => console.warn('[Seen Update Fail]:', err));
        }
      });

      // Remove any rendered messages that are no longer in the paginated set
      const docIds = new Set(chronDocs.map(d => d.id));
      const renderedMsgs = messagesArea.querySelectorAll('.message');
      renderedMsgs.forEach(el => {
        const id = el.dataset.msgId;
        if (id && !docIds.has(id)) {
          el.remove();
        }
      });

      // Rebuild date separators
      rebuildDateSeparators(messagesArea, typingIndicator);

      // Handle scrolling behavior
      if (preventScrollJump) {
        messagesArea.scrollTop = messagesArea.scrollHeight - prevScrollHeight + prevScrollTop;
        preventScrollJump = false;
      } else {
        const lastMsg = chronDocs[chronDocs.length - 1]?.data();
        const sentByMe = lastMsg && lastMsg.senderId === myUid;
        scrollMessagesToBottom(sentByMe);
      }

      // Update scroll-to-bottom badge for unread count when scrolled up
      let unreadCount = 0;
      chronDocs.forEach((doc) => {
        const msg = doc.data();
        if (msg.senderId !== myUid && !msg.seen) {
          unreadCount++;
        }
      });
      const badge = document.getElementById('scrollUnreadBadge');
      if (badge) {
        badge.textContent = unreadCount > 0 ? unreadCount : '';
      }

    }, (err) => {
      console.error('[Chat] Query subscription error:', err);
      showToast('Messages could not be loaded: ' + err.message, 'error');
    });
  }

  // ── Scroll lazy loading listener ──
  function setupScrollListener() {
    const area = document.getElementById('messagesArea');
    area.onscroll = () => {
      // If user reaches top, load older messages
      if (area.scrollTop === 0 && !allMessagesLoaded) {
        preventScrollJump = true;
        messagesLimit += 30;
        subscribeToMessageQuery(currentChatId, getCurrentUser().uid);
      }

      // Toggle floating button visibility
      const scrollBottomDiff = area.scrollHeight - area.scrollTop - area.clientHeight;
      const scrollBtn = document.getElementById('scrollToBottomBtn');
      if (!scrollBtn) return;
      if (scrollBottomDiff > 250) {
        scrollBtn.classList.add('show');
      } else {
        scrollBtn.classList.remove('show');
      }
    };
  }

  function createMessageElement(msg, myUid) {
    const div = document.createElement('div');
    div.className = `message ${msg.senderId === myUid ? 'sent' : 'received'}`;
    div.dataset.msgId = msg.id;
    div.dataset.msgDate = formatDate(msg.createdAt);
    updateMessageDOM(div, msg, myUid);
    return div;
  }

  function updateMessageDOM(div, msg, myUid) {
    const isSent = msg.senderId === myUid;
    let content = '';

    // Handle replies
    if (msg.replyTo) {
      content += `
        <div class="reply-quote" onclick="scrollToMessage('${msg.replyTo.messageId}')">
          <div class="reply-quote-sender">${msg.replyTo.senderId === myUid ? 'You' : msg.replyTo.senderName}</div>
          <div class="reply-quote-text">${escapeHtml(msg.replyTo.text)}</div>
        </div>
      `;
    }

    // Render contents based on message type
    if (msg.deleted) {
      content += `<div class="message-text italicized" style="font-style:italic;opacity:0.6;">🚫 This message was deleted</div>`;
    } else {
      if (msg.type === 'image' && msg.fileUrl) {
        content += `<img class="message-image" src="${msg.fileUrl}" alt="Shared image" loading="lazy" onclick="openLightbox('${msg.fileUrl}')">`;
      } else if (msg.type === 'video' && msg.fileUrl) {
        content += `<video class="message-image" src="${msg.fileUrl}" controls width="250" loading="lazy"></video>`;
      } else if (msg.type === 'voice' && msg.fileUrl) {
        // Custom Audio playback widget
        const speed = voiceSpeedRates[msg.id] || 1;
        content += `
          <div class="voice-message-bubble">
            <button class="voice-play-btn" id="voicePlay_${msg.id}" onclick="toggleVoicePlayback('${msg.id}', '${msg.fileUrl}')">▶</button>
            <div class="voice-wave-container">
              <div class="voice-progress-bar" id="voiceProgressContainer_${msg.id}" onclick="seekVoiceMessage(event, '${msg.id}')">
                <div class="voice-progress-fill" id="voiceProgressFill_${msg.id}"></div>
              </div>
              <div class="voice-time-row">
                <span id="voiceCurrent_${msg.id}">0:00</span>
                <span class="voice-speed-badge" onclick="cycleVoiceSpeed('${msg.id}')">${speed}x</span>
              </div>
            </div>
            <audio id="audio_${msg.id}" src="${msg.fileUrl}" class="sr-only"></audio>
          </div>
        `;
      } else if (msg.type === 'file' && msg.fileUrl) {
        const ext = (msg.fileName || '').split('.').pop().toUpperCase() || 'FILE';
        const fileIcon = getFileIcon(ext);
        content += `
          <a class="message-file" href="${msg.fileUrl}" target="_blank" rel="noopener">
            <div class="file-icon">${fileIcon}</div>
            <div class="file-info">
              <div class="file-name">${msg.fileName || 'Shared Document'}</div>
              <div class="file-size">${formatFileSize(msg.fileSize || 0)} · ${ext}</div>
            </div>
          </a>
        `;
      }

      if (msg.text) {
        content += `<div class="message-text">${linkifyText(escapeHtml(msg.text))}</div>`;
      }
    }

    const time = formatTime(msg.createdAt);
    const statusHtml = getMessageStatusTicks(msg, isSent);

    // Emoji reactions lists
    let reactionHtml = '';
    if (msg.reactions && Object.keys(msg.reactions).length > 0) {
      const counts = {};
      Object.values(msg.reactions).forEach(e => { counts[e] = (counts[e] || 0) + 1; });
      const emojis = Object.keys(counts).join(' ');
      reactionHtml = `<div class="bubble-reactions-list" title="Reactions: ${emojis}">${emojis} <span style="opacity:0.6;">${Object.keys(msg.reactions).length}</span></div>`;
    }

    // Build context dropdown elements
    const quoteText = escapeQuoteText(msg.text || '[Attachment]');

    const targetInner = `
      <div class="message-bubble" oncontextmenu="openMessageContextMenu(event, '${msg.id}', ${isSent}, '${quoteText}')" style="user-select:none;">
        ${content}
        <div class="message-meta">
          ${msg.edited ? '<span class="message-edited" style="font-size:8px;opacity:0.5;margin-right:2px;">edited</span>' : ''}
          <span class="message-time">${time}</span>
          ${statusHtml}
        </div>
        ${reactionHtml}
      </div>
    `;

    if (div.innerHTML !== targetInner) {
      div.innerHTML = targetInner;
    }
  }

  function appendMessageDOM(msg, myUid, container, typingIndicator) {
    const div = createMessageElement(msg, myUid);
    container.insertBefore(div, typingIndicator);
    rebuildDateSeparators(container, typingIndicator);
  }

  function rebuildDateSeparators(messagesArea, typingIndicator) {
    const separators = messagesArea.querySelectorAll('.date-separator');
    separators.forEach(el => el.remove());

    const messages = Array.from(messagesArea.querySelectorAll('.message'));
    let lastDate = null;

    messages.forEach((msgDiv) => {
      const msgDate = msgDiv.dataset.msgDate;
      if (msgDate && msgDate !== lastDate) {
        lastDate = msgDate;
        const sep = document.createElement('div');
        sep.className = 'date-separator';
        sep.innerHTML = `<span>${msgDate}</span>`;
        messagesArea.insertBefore(sep, msgDiv);
      }
    });
  }

  // Seen status ticks (sending -> grey check -> double grey -> blue check)
  function getMessageStatusTicks(msg, isSent) {
    if (!isSent) return '';
    if (msg.sending) {
      return '<span class="message-status text-muted" title="Sending">🕒</span>';
    }
    if (msg.seen) {
      return '<span class="message-status" style="color:var(--accent-cyan);" title="Seen">✓✓</span>';
    }

    // Check if recipient is active in current conversation
    const otherOnline = window._currentContact && window._currentContact.online === true;
    if (otherOnline) {
      return '<span class="message-status delivered" title="Delivered">✓✓</span>';
    }
    return '<span class="message-status" title="Sent">✓</span>';
  }

  // Regex parser to convert links/mentions inside bubbles
  function linkifyText(text) {
    // Escape standard content, then wrap URLs and mentions
    const urlPattern = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
    let html = text.replace(urlPattern, '<a href="$1" target="_blank" rel="noopener">$1</a>');

    // Mentions pattern (@018...)
    const mentionPattern = /@(\d+)/g;
    html = html.replace(mentionPattern, '<strong class="user-mention" style="color:var(--accent-cyan);cursor:pointer;" onclick="openMentionedProfile(\'$1\')">@$1</strong>');
    return html;
  }

  // ── Messaging options, context menus ──
  let activeContextMsgId = null;

  window.openMessageContextMenu = function (event, msgId, isSent, textContent) {
    event.preventDefault();
    event.stopPropagation();
    activeContextMsgId = msgId;

    const menu = document.getElementById('reactionContextMenu');
    menu.classList.add('show');

    const padding = 8;
    const menuRect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    let left = event.clientX;
    let top = event.clientY;

    if (left + menuRect.width + padding > viewportWidth) {
      left = viewportWidth - menuRect.width - padding;
    }
    if (top + menuRect.height + padding > viewportHeight) {
      top = viewportHeight - menuRect.height - padding;
    }

    menu.style.left = Math.max(padding, left) + 'px';
    menu.style.top = Math.max(padding, top) + 'px';

    // Toggle options contextually
    document.getElementById('btnContextEdit').classList.toggle('hidden', !isSent);
    document.getElementById('btnContextDeleteEveryone').classList.toggle('hidden', !isSent);

    // Auto-dismiss context menu when clicking outside
    setTimeout(() => {
      document.addEventListener('click', closeMessageContextMenu, { once: true });
    }, 0);
  };

  function closeMessageContextMenu() {
    document.getElementById('reactionContextMenu').classList.remove('show');
  }

  window.addReactionFromMenu = async function (emoji) {
    if (!activeContextMsgId || !currentChatId) return;
    const myUid = getCurrentUser().uid;

    try {
      const msgRef = db.collection('chats').doc(currentChatId).collection('messages').doc(activeContextMsgId);
      const doc = await msgRef.get();
      if (!doc.exists) return;

      const data = doc.data();
      const currentReactions = data.reactions || {};

      // Toggle reaction
      if (currentReactions[myUid] === emoji) {
        delete currentReactions[myUid];
      } else {
        currentReactions[myUid] = emoji;
      }

      await msgRef.update({ reactions: currentReactions });
    } catch (e) {
      showToast('Could not save reaction', 'error');
    }
  };

  window.triggerContextAction = async function (action) {
    if (!activeContextMsgId || !currentChatId) return;
    const myUid = getCurrentUser().uid;

    const msgRef = db.collection('chats').doc(currentChatId).collection('messages').doc(activeContextMsgId);

    try {
      const doc = await msgRef.get();
      if (!doc.exists) return;
      const data = doc.data();

      if (action === 'reply') {
        window.triggerReply(doc.id, data.senderId, data.text || '[Attachment]');
      } else if (action === 'star') {
        // Toggle Starred state in Firestore user doc
        await toggleStarMessage(doc.id, data);
      } else if (action === 'copy') {
        navigator.clipboard.writeText(data.text || '');
        showToast('Message copied to clipboard', 'success');
      } else if (action === 'forward') {
        openForwardModal(data);
      } else if (action === 'edit') {
        // Edit within 15 minutes limit
        const ageInMs = Date.now() - (data.createdAt ? data.createdAt.toDate().getTime() : Date.now());
        const ageInMinutes = ageInMs / (1000 * 60);

        if (ageInMinutes > 15) {
          showToast('Messages can only be edited within 15 minutes.', 'warning');
          return;
        }
        setupMessageEditing(doc.id, data.text);
      } else if (action === 'info') {
        openMessageInfoModal(data);
      } else if (action === 'delete_me') {
        // Hide for me only
        const deletedBy = data.deletedBy || {};
        deletedBy[myUid] = true;
        await msgRef.update({ deletedBy: deletedBy });
        showToast('Message deleted for you', 'info');
      } else if (action === 'delete_everyone') {
        // Full delete
        await msgRef.update({
          deleted: true,
          text: '',
          type: 'text',
          fileUrl: firebase.firestore.FieldValue.delete(),
          fileName: firebase.firestore.FieldValue.delete()
        });
        showToast('Message deleted for everyone', 'info');
      }
    } catch (e) {
      console.warn('[Chat] Context Action Fail:', e);
    }
  };

  // Star message triggers
  async function toggleStarMessage(msgId, msgData) {
    const user = getCurrentUser();
    const userRef = db.collection('users').doc(user.uid);
    const doc = await userRef.get();

    const starredList = doc.data().starredMessages || [];
    const idx = starredList.findIndex(s => s.messageId === msgId);

    if (idx > -1) {
      starredList.splice(idx, 1);
      showToast('Message unstarred', 'info');
    } else {
      starredList.push({
        messageId: msgId,
        senderId: msgData.senderId,
        text: msgData.text || '[Attachment]',
        chatId: currentChatId,
        createdAt: new Date()
      });
      showToast('Message starred', 'success');
    }
    await userRef.update({ starredMessages: starredList });
  }

  // ── Forward message selectors logic ──
  let forwardPayload = null;

  function openForwardModal(msgData) {
    forwardPayload = msgData;
    const modal = document.getElementById('forwardModal');
    const container = document.getElementById('forwardContactsList');
    container.innerHTML = '';

    cachedContacts.forEach(c => {
      const div = document.createElement('div');
      div.className = 'forward-contact-item';
      div.innerHTML = `<span>${c.displayName}</span><button class="accept-btn" style="padding:4px 8px;font-size:11px;">Send</button>`;
      div.onclick = () => forwardMessageTo(c.chatId);
      container.appendChild(div);
    });

    modal.classList.add('show');
  }

  window.closeForwardModal = function (event) {
    if (!event || event.target === event.currentTarget) {
      document.getElementById('forwardModal').classList.remove('show');
    }
  };

  async function forwardMessageTo(targetChatId) {
    if (!forwardPayload) return;
    const user = getCurrentUser();

    try {
      const msgRef = db.collection('chats').doc(targetChatId).collection('messages');
      await msgRef.add({
        senderId: user.uid,
        text: forwardPayload.text || '',
        type: forwardPayload.type,
        fileUrl: forwardPayload.fileUrl || null,
        fileName: forwardPayload.fileName || null,
        fileSize: forwardPayload.fileSize || null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        seen: false
      });

      showToast('Message forwarded successfully', 'success');
      document.getElementById('forwardModal').classList.remove('show');
    } catch (e) {
      showToast('Forwarding failed', 'error');
    }
  }

  // ── Message Info Modal Details ──
  window.openMessageInfoModal = function (msgData) {
    const modal = document.getElementById('messageInfoModal');
    document.getElementById('infoMsgSentTime').textContent = msgData.createdAt ? msgData.createdAt.toDate().toLocaleString() : '';

    const delList = document.getElementById('infoMsgDeliveredList');
    const seenList = document.getElementById('infoMsgSeenList');
    delList.innerHTML = '';
    seenList.innerHTML = '';

    // Render exact timestamps from seenBy map
    if (msgData.seenBy) {
      Object.entries(msgData.seenBy).forEach(([uid, timeVal]) => {
        const timeStr = timeVal ? (timeVal.toDate ? timeVal.toDate().toLocaleTimeString() : new Date(timeVal).toLocaleTimeString()) : 'pending';
        const row = document.createElement('div');
        row.className = 'info-status-item';
        row.innerHTML = `<span>User ${uid.substr(0,4)}</span><span>${timeStr}</span>`;
        seenList.appendChild(row);
      });
    }

    modal.classList.add('show');
  };

  window.closeMessageInfoModal = function (event) {
    if (!event || event.target === event.currentTarget) {
      document.getElementById('messageInfoModal').classList.remove('show');
    }
  };

  // ── Editing target logic ──
  let activeEditingMsgId = null;

  function setupMessageEditing(msgId, text) {
    activeEditingMsgId = msgId;
    document.getElementById('editPreviewText').textContent = text;
    document.getElementById('inputEditPreview').classList.add('show');

    const input = document.getElementById('messageInput');
    input.value = text;
    input.focus();
  }

  window.clearEditMessage = function () {
    activeEditingMsgId = null;
    document.getElementById('inputEditPreview').classList.remove('show');
    document.getElementById('messageInput').value = '';
  };

  // ── Voice playbacks widget controls ──
  window.toggleVoicePlayback = function (msgId, url) {
    const audio = document.getElementById('audio_' + msgId);
    const playBtn = document.getElementById('voicePlay_' + msgId);
    const progressFill = document.getElementById('voiceProgressFill_' + msgId);
    const currentTimer = document.getElementById('voiceCurrent_' + msgId);

    if (audio.paused) {
      // Pause all other audio playing
      document.querySelectorAll('audio').forEach(a => { if (a !== audio) a.pause(); });

      audio.play();
      playBtn.textContent = '⏸';

      audio.ontimeupdate = () => {
        const pct = (audio.currentTime / audio.duration) * 100;
        progressFill.style.width = pct + '%';

        const min = Math.floor(audio.currentTime / 60);
        const sec = Math.floor(audio.currentTime % 60);
        currentTimer.textContent = `${min}:${String(sec).padStart(2, '0')}`;
      };

      audio.onended = () => {
        playBtn.textContent = '▶';
        progressFill.style.width = '0%';
        currentTimer.textContent = '0:00';
      };
    } else {
      audio.pause();
      playBtn.textContent = '▶';
    }
  };

  window.seekVoiceMessage = function (event, msgId) {
    const audio = document.getElementById('audio_' + msgId);
    const bar = document.getElementById('voiceProgressContainer_' + msgId);
    const rect = bar.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const width = rect.width;

    if (audio && audio.duration) {
      audio.currentTime = (clickX / width) * audio.duration;
    }
  };

  window.cycleVoiceSpeed = function (msgId) {
    const audio = document.getElementById('audio_' + msgId);
    if (!audio) return;

    let currentSpeed = voiceSpeedRates[msgId] || 1;
    let nextSpeed = 1;

    if (currentSpeed === 1) nextSpeed = 1.5;
    else if (currentSpeed === 1.5) nextSpeed = 2;
    else if (currentSpeed === 2) nextSpeed = 0.5;
    else nextSpeed = 1;

    voiceSpeedRates[msgId] = nextSpeed;
    audio.playbackRate = nextSpeed;

    // Update badge in DOM
    const badge = document.querySelector(`#voiceCurrent_${msgId} ~ .voice-speed-badge`);
    if (badge) badge.textContent = nextSpeed + 'x';
  };

  // ── Send message handlers (with offline queue queueing) ──
  window.sendMessage = async function (text, files) {
    const user = getCurrentUser();
    if (!user || !currentChatId) {
      showToast('Select a conversation before sending.', 'error');
      return false;
    }

    clearTypingStatus();

    const reply = window._replyTarget;
    window.clearReply();

    // Check internet connection
    const isOffline = !navigator.onLine;

    // Send files first
    if (files && files.length > 0) {
      if (isOffline) {
        showToast('Cannot send files while offline', 'error');
        return false;
      }
      for (const file of files) {
        const sent = await uploadAndSendFile(file, user.uid, currentChatId, reply);
        if (!sent) return false;
      }
    }

    // Send text/edits
    if (text && text.trim()) {
      if (activeEditingMsgId) {
        // Edit update
        try {
          await db.collection('chats').doc(currentChatId).collection('messages').doc(activeEditingMsgId).update({
            text: text.trim(),
            edited: true,
            editedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
          showToast('Message updated', 'success');
        } catch (e) {
          showToast('Edit failed: ' + e.message, 'error');
          return false;
        }
        window.clearEditMessage();
      } else {
        try {
          await ensureConversationReady(currentChatId, window._currentContact);
        } catch (e) {
          showToast('Could not prepare this conversation: ' + e.message, 'error');
          return false;
        }

        const clientMessageId = createClientMessageId(user.uid);
        // Create new text message
        const msgData = {
          clientMessageId,
          senderId: user.uid,
          senderName: window._myDetails?.displayName || user.phoneNumber || user.email || 'User',
          text: text.trim(),
          type: 'text',
          createdAt: new Date(),
          seen: false
        };

        if (reply) {
          msgData.replyTo = {
            messageId: reply.id,
            senderId: reply.senderId,
            senderName: reply.senderName || (window._currentContact && window._currentContact.displayName) || 'Contact',
            text: reply.text || ''
          };
        }

        if (isOffline) {
          // Push to pending offline queue
          msgData.sending = true;
          msgData.id = 'temp_' + Math.random().toString(36).substr(2, 9);
          pendingMessageQueue.push({ chatId: currentChatId, data: msgData });
          persistPendingMessageQueue();

          // Append instantly to local DOM for real-time responsiveness
          const messagesArea = document.getElementById('messagesArea');
          const typingIndicator = document.getElementById('typingIndicator');
          appendMessageDOM(msgData, user.uid, messagesArea, typingIndicator);
          scrollMessagesToBottom(true);

          showToast('Message queued. Will send when online.', 'info');
        } else {
          msgData.id = clientMessageId;
          msgData.sending = true;
          const messagesArea = document.getElementById('messagesArea');
          const typingIndicator = document.getElementById('typingIndicator');
          appendMessageDOM(msgData, user.uid, messagesArea, typingIndicator);
          scrollMessagesToBottom(true);

          try {
            const messageRef = db.collection('chats').doc(currentChatId).collection('messages').doc(clientMessageId);
            const firestoreMessage = { ...msgData };
            delete firestoreMessage.id;
            delete firestoreMessage.sending;
            firestoreMessage.createdAt = firebase.firestore.FieldValue.serverTimestamp();
            await messageRef.set(firestoreMessage);

            // Update chat metadata
            await db.collection('chats').doc(currentChatId).set({
              lastMessage: text.trim(),
              lastMessageTime: firebase.firestore.FieldValue.serverTimestamp(),
              lastMessageSender: user.uid
            }, { merge: true });
          } catch (e) {
            console.error('[Chat] Text Send fail:', e);
            const failedBubble = document.querySelector(`[data-msg-id="${clientMessageId}"]`);
            if (failedBubble) failedBubble.classList.add('failed');
            showToast('Message failed to send: ' + e.message, 'error');
            return false;
          }
        }
      }
    }
    return true;
  };

  // Expose sendFileMessage for file-upload.js module
  window.sendFileMessage = async function (file, senderId, chatId, reply) {
    return uploadAndSendFile(file, senderId, chatId, reply);
  };

  async function uploadAndSendFile(file, senderId, chatId, reply) {
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    const isAudio = file.type.startsWith('audio/') || file.name.endsWith('.webm');

    let msgType = 'file';
    if (isImage) msgType = 'image';
    else if (isVideo) msgType = 'video';
    else if (isAudio) msgType = 'voice';

    try {
      await ensureConversationReady(chatId, chatId === currentChatId ? window._currentContact : null);

      const url = await window.uploadFile(file, chatId);
      if (!url) return false;

      const msgData = {
        senderId: senderId,
        senderName: window._myDetails?.displayName || getCurrentUser().phoneNumber || getCurrentUser().email || 'User',
        text: '',
        type: msgType,
        fileUrl: url,
        fileName: file.name || 'file',
        fileSize: file.size || 0,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        seen: false
      };

      if (reply) {
        msgData.replyTo = {
          messageId: reply.id,
          senderId: reply.senderId,
          senderName: reply.senderName || (window._currentContact && window._currentContact.displayName) || 'Contact',
          text: reply.text || ''
        };
      }

      await db.collection('chats').doc(chatId).collection('messages').add(msgData);

      const preview = isImage ? '📷 Photo' : (isVideo ? '📹 Video' : (isAudio ? '🎵 Voice message' : '📎 ' + file.name));
      await db.collection('chats').doc(chatId).set({
        lastMessage: preview,
        lastMessageTime: firebase.firestore.FieldValue.serverTimestamp(),
        lastMessageSender: senderId
      }, { merge: true });
      return true;

    } catch (error) {
      console.error('[Chat] File Send error:', error);
      showToast('Failed to send file: ' + file.name, 'error');
      return false;
    }
  }

  // Flush queued messages when internet restores
  async function flushPendingMessageQueue() {
    restorePendingMessageQueue();
    if (pendingMessageQueue.length === 0 || flushInProgress) return;
    flushInProgress = true;
    showToast('Reconnected. Syncing messages...', 'success');

    const queue = [...pendingMessageQueue];
    pendingMessageQueue = [];

    for (const item of queue) {
      try {
        const cleaned = { ...item.data };
        delete cleaned.sending;
        delete cleaned.id;
        cleaned.createdAt = firebase.firestore.FieldValue.serverTimestamp();

        const messageId = item.data.clientMessageId || createClientMessageId(item.data.senderId || 'queued');
        cleaned.clientMessageId = messageId;
        await db.collection('chats').doc(item.chatId).collection('messages').doc(messageId).set(cleaned, { merge: true });
        await db.collection('chats').doc(item.chatId).set({
          lastMessage: cleaned.text || '[Attachment]',
          lastMessageTime: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (e) {
        // Push back
        pendingMessageQueue.push(item);
      }
    }
    persistPendingMessageQueue();
    flushInProgress = false;
  }

  // ── Typing & recording statuses ──
  window.setTypingStatus = function (isTyping) {
    const user = getCurrentUser();
    if (!user || !currentChatId) return;

    db.collection('chats').doc(currentChatId).collection('typing').doc(user.uid).set({
      isTyping: isTyping,
      isRecording: false,
      timestamp: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});
  };

  window.setRecordingStatus = function (isRecording) {
    const user = getCurrentUser();
    if (!user || !currentChatId) return;

    db.collection('chats').doc(currentChatId).collection('typing').doc(user.uid).set({
      isTyping: false,
      isRecording: isRecording,
      timestamp: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});
  };

  function clearTypingStatus() {
    if (typingTimeout) clearTimeout(typingTimeout);
    if (window.setTypingStatus) {
      window.setTypingStatus(false);
    }
  }

  window.handleTyping = function () {
    if (window.setTypingStatus) {
      window.setTypingStatus(true);
    }
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      if (window.setTypingStatus) {
        window.setTypingStatus(false);
      }
    }, 2000);
  };

  window.listenForTyping = function (chatId, otherUid) {
    const indicator = document.getElementById('typingIndicator');
    const headerStatus = document.getElementById('chatStatus');

    if (typingUnsubscribe) {
      typingUnsubscribe();
      typingUnsubscribe = null;
    }

    typingUnsubscribe = db.collection('chats').doc(chatId).collection('typing')
      .onSnapshot((snapshot) => {
        incrementFirestoreReads(snapshot.size);
        let someoneTyping = false;
        let someoneRecording = false;

        snapshot.forEach((doc) => {
          if (doc.id === getCurrentUser().uid) return;
          const data = doc.data();
          if (data.isTyping) someoneTyping = true;
          if (data.isRecording) someoneRecording = true;
        });

        if (someoneTyping) {
          indicator.classList.add('show');
          headerStatus.textContent = 'typing...';
          headerStatus.classList.add('online');
          scrollMessagesToBottom(false);
        } else if (someoneRecording) {
          indicator.classList.remove('show');
          headerStatus.textContent = 'recording audio...';
          headerStatus.classList.add('online');
        } else {
          indicator.classList.remove('show');
          // Reset default status string
          if (window._currentContact) {
            updateActiveContactStatus(window._currentContact);
          }
        }
      });
  };

  // ── Group creation triggers ──
  window.triggerReply = function (msgId, senderId, text) {
    const msgInput = document.getElementById('messageInput');
    const preview = document.getElementById('inputReplyPreview');
    const previewSender = document.getElementById('replyPreviewSender');
    const previewText = document.getElementById('replyPreviewText');
    const user = getCurrentUser();
    const senderName = senderId === user?.uid ? 'You' : (window._currentContact?.displayName || 'Contact');

    window._replyTarget = {
      id: msgId,
      senderId: senderId,
      senderName: senderName,
      text: text || '[Attachment]'
    };

    if (previewSender) previewSender.textContent = senderName;
    if (previewText) previewText.textContent = window._replyTarget.text;
    if (preview) preview.classList.add('show');
    if (msgInput) msgInput.focus({ preventScroll: true });
  };

  window.clearReply = function () {
    window._replyTarget = null;
    document.getElementById('inputReplyPreview')?.classList.remove('show');
  };

  window.createGroupChat = async function () {
    const user = getCurrentUser();
    const name = document.getElementById('groupNameInput').value.trim();
    const desc = document.getElementById('groupDescInput').value.trim();

    if (!name) {
      showToast('Group name is required', 'warning');
      return;
    }

    // Find selected contact checkboxes
    const participants = [user.uid];
    document.querySelectorAll('.group-participant-check:checked').forEach(cb => {
      participants.push(cb.value);
    });

    try {
      const groupRef = db.collection('chats').doc();
      const code = 'invite_' + Math.random().toString(36).substr(2, 9);

      await groupRef.set({
        name: name,
        description: desc,
        isGroup: true,
        participants: participants,
        admins: [user.uid],
        coAdmins: [],
        inviteLinkCode: code,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        lastMessage: 'Group created',
        lastMessageTime: firebase.firestore.FieldValue.serverTimestamp()
      });

      showToast('Group created successfully!', 'success');
      closeDrawer('groupDrawer');

      // Auto open group chat
      if (window.openChat) {
        window.openChat({
          chatId: groupRef.id,
          uid: groupRef.id,
          isGroup: true,
          displayName: name,
          participants: participants
        });
      }

    } catch (e) {
      showToast('Could not create group', 'error');
    }
  };

  // ── Global Search filter ──
  // Searches text inside messages, users, or conversations
  window.triggerGlobalSearch = function (query) {
    // Tweak cached list filtering based on search query
    if (window.filterContacts) {
      window.filterContacts();
    }
  };

  // Active chat inner messages text search
  window.toggleChatMessageSearch = function () {
    const bar = document.getElementById('headerChatSearch');
    bar.classList.toggle('hidden');

    const input = document.getElementById('chatMessageSearchInput');
    if (!bar.classList.contains('hidden')) {
      input.focus();
      input.oninput = () => {
        const text = input.value.trim().toLowerCase();
        document.querySelectorAll('.message').forEach(el => {
          const body = el.querySelector('.message-text')?.textContent.toLowerCase() || '';
          el.style.opacity = body.includes(text) ? '1' : '0.2';
        });
      };
    } else {
      input.value = '';
      document.querySelectorAll('.message').forEach(el => el.style.opacity = '1');
    }
  };

  // ── Scroll Helpers ──
  function scrollMessagesToBottom(force) {
    const messagesArea = document.getElementById('messagesArea');
    if (messagesArea) {
      const isAtBottom = messagesArea.scrollHeight - messagesArea.scrollTop - messagesArea.clientHeight < 200;
      if (isAtBottom || force) {
        requestAnimationFrame(() => {
          messagesArea.scrollTop = messagesArea.scrollHeight;
        });
      }
    }
  }

  window.scrollMessagesToBottom = scrollMessagesToBottom;

  window.scrollToMessage = function (msgId) {
    const el = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.backgroundColor = 'rgba(0, 212, 255, 0.2)';
      setTimeout(() => { el.style.backgroundColor = ''; }, 1000);
    } else {
      showToast('Message not found', 'info');
    }
  };

  // ── Custom theme switches ──
  window.changeThemePreference = function (themeName) {
    document.body.setAttribute('data-theme', themeName);
    localStorage.setItem('chatvibe_theme', themeName);
    showToast('Theme switched to ' + themeName, 'success');
  };

  window.changeChatWallpaper = function (wpName) {
    const user = getCurrentUser();
    if (!user || !currentChatId) return;

    db.collection('chats').doc(currentChatId).update({
      [`wallpaper.${user.uid}`]: wpName
    }).then(() => {
      showToast('Wallpaper updated', 'success');
    });
  };

  // Mute / Unmute Active Chat
  window.toggleMuteActiveChat = async function () {
    const user = getCurrentUser();
    if (!user || !currentChatId) return;

    const isMuted = activeChatDetails?.mutedBy && activeChatDetails.mutedBy[user.uid] === true;
    try {
      await db.collection('chats').doc(currentChatId).update({
        [`mutedBy.${user.uid}`]: !isMuted
      });
      showToast(isMuted ? 'Notifications unmuted' : 'Notifications muted', 'success');
    } catch (e) {
      showToast('Action failed', 'error');
    }
  };

  // Favorite / Unfavorite Active Chat
  window.toggleFavoriteActiveChat = async function () {
    const user = getCurrentUser();
    if (!user || !currentChatId) return;

    const isFav = activeChatDetails?.favoritedBy && activeChatDetails.favoritedBy[user.uid] === true;
    try {
      await db.collection('chats').doc(currentChatId).update({
        [`favoritedBy.${user.uid}`]: !isFav
      });
      showToast(isFav ? 'Removed from favorites' : 'Added to favorites', 'success');
    } catch (e) {
      showToast('Action failed', 'error');
    }
  };

  // Archive / Unarchive active conversation
  window.archiveActiveChat = async function () {
    const user = getCurrentUser();
    if (!user || !currentChatId) return;

    const isArchived = activeChatDetails?.archivedBy && activeChatDetails.archivedBy[user.uid] === true;
    try {
      await db.collection('chats').doc(currentChatId).update({
        [`archivedBy.${user.uid}`]: !isArchived
      });
      showToast(isArchived ? 'Chat unarchived' : 'Chat archived', 'success');

      // Reset active selections
      document.getElementById('noChat').classList.remove('hidden');
      document.getElementById('chatHeader').classList.add('hidden');
      document.getElementById('messagesArea').classList.add('hidden');
      document.getElementById('messageInputArea').classList.add('hidden');
    } catch (e) {
      showToast('Action failed', 'error');
    }
  };

  // Block contact user
  window.blockActiveChatContact = async function () {
    const user = getCurrentUser();
    if (!user || !currentContactUid) return;

    const blocksList = window._myDetails?.blockedUsers || [];
    const isBlocked = blocksList.includes(currentContactUid);

    try {
      if (isBlocked) {
        const idx = blocksList.indexOf(currentContactUid);
        blocksList.splice(idx, 1);
      } else {
        blocksList.push(currentContactUid);
      }

      await db.collection('users').doc(user.uid).update({ blockedUsers: blocksList });
      showToast(isBlocked ? 'Contact unblocked' : 'Contact blocked', 'success');
    } catch (e) {
      showToast('Block update failed', 'error');
    }
  };

  // Starred messages panel drawers render
  window.renderStarredMessagesList = function () {
    const container = document.getElementById('starredMessagesList');
    const user = getCurrentUser();
    if (!user) return;

    db.collection('users').doc(user.uid).get().then(doc => {
      if (!doc.exists) return;
      const starred = doc.data().starredMessages || [];

      if (starred.length === 0) {
        container.innerHTML = '<div class="empty-text">No starred messages yet</div>';
        return;
      }

      container.innerHTML = '';
      starred.forEach(s => {
        const item = document.createElement('div');
        item.className = 'starred-msg-item';
        item.innerHTML = `
          <div class="starred-msg-sender">From: User ${s.senderId.substr(0,4)}</div>
          <div class="starred-msg-text">${escapeHtml(s.text)}</div>
          <div class="starred-msg-date">${new Date(s.createdAt).toLocaleDateString()}</div>
        `;
        container.appendChild(item);
      });
    });
  };

  // Dynamic values dashboard analytics updates
  function updateAnalyticsDashboard() {
    const onlineEl = document.getElementById('analyticsOnlineCount');
    const readsEl = document.getElementById('analyticsFirestoreReads');
    const sizeEl = document.getElementById('analyticsStorageUsage');

    if (onlineEl) {
      // Find count of online users
      const count = cachedContacts.filter(c => !c.isGroup && isFreshPresence(c)).length;
      onlineEl.textContent = count;
    }
    if (readsEl) {
      readsEl.textContent = localStorage.getItem('chatvibe_analytics_reads') || '0';
    }
    if (sizeEl) {
      const bytes = parseInt(localStorage.getItem('chatvibe_analytics_storage') || '0');
      sizeEl.textContent = (bytes / 1024).toFixed(1) + ' KB';
    }
  }

  // ── Active Chat details modal display ──
  window.openActiveChatInfoModal = function () {
    if (!activeChatDetails) return;
    const modal = document.getElementById('chatInfoModal');

    document.getElementById('modalChatName').textContent = document.getElementById('chatName').textContent;
    document.getElementById('modalChatDescription').textContent = activeChatDetails.description || 'No description set';

    // Group participants rendering
    const list = document.getElementById('modalParticipantsList');
    list.innerHTML = '';

    if (activeChatDetails.isGroup) {
      document.getElementById('groupAdminSettings').classList.remove('hidden');
      document.getElementById('modalParticipantsSection').classList.remove('hidden');

      document.getElementById('modalParticipantsCount').textContent = activeChatDetails.participants?.length || 0;

      // Render members
      (activeChatDetails.participants || []).forEach(p => {
        const row = document.createElement('div');
        row.className = 'participant-row-item';

        const isAdmin = activeChatDetails.admins?.includes(p);
        const isCoadmin = activeChatDetails.coAdmins?.includes(p);

        row.innerHTML = `
          <span>User ${p.substr(0, 4)}</span>
          <div class="participant-badge-row">
            ${isAdmin ? '<span class="participant-badge admin">Admin</span>' : ''}
            ${isCoadmin ? '<span class="participant-badge coadmin">Co-admin</span>' : ''}
          </div>
        `;
        list.appendChild(row);
      });
    } else {
      document.getElementById('groupAdminSettings').classList.add('hidden');
      document.getElementById('modalParticipantsSection').classList.add('hidden');
    }

    modal.classList.add('show');
  };

  window.closeActiveChatInfoModal = function (event) {
    if (!event || event.target === event.currentTarget) {
      document.getElementById('chatInfoModal').classList.remove('show');
    }
  };

  // Helpers
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function escapeQuoteText(str) {
    if (!str) return '';
    return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
  }

  function getFileIcon(ext) {
    const icons = {
      'PDF': '📄', 'DOC': '📝', 'DOCX': '📝',
      'XLS': '📊', 'XLSX': '📊', 'TXT': '📃',
      'ZIP': '🗜️', 'RAR': '🗜️', 'MP4': '🎬',
      'MP3': '🎵', 'WAV': '🎵', 'APK': '🤖'
    };
    return icons[ext] || '📁';
  }

  function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  // ── Drawer panels controls ──
  window.openDrawer = function (drawerId) {
    document.getElementById(drawerId).classList.add('show');
    if (drawerId === 'starredDrawer') {
      window.renderStarredMessagesList();
    } else if (drawerId === 'settingsDrawer') {
      window.renderSettingsDrawer();
    }
  };

  window.closeDrawer = function (drawerId) {
    document.getElementById(drawerId).classList.remove('show');
  };

  // Settings drawer contents list loader
  window.renderSettingsDrawer = function () {
    const container = document.getElementById('deviceSessionsContainer');
    const user = getCurrentUser();
    if (!user) return;

    db.collection('users').doc(user.uid).get().then(doc => {
      if (!doc.exists) return;
      const sessions = doc.data().deviceSessions || [];
      container.innerHTML = '';

      sessions.forEach(s => {
        const item = document.createElement('div');
        item.className = 'session-item';
        item.innerHTML = `
          <div class="session-info">
            <div class="dev">${s.deviceInfo}</div>
            <div class="time">Last active: ${new Date(s.lastActive.toDate ? s.lastActive.toDate() : s.lastActive).toLocaleTimeString()}</div>
          </div>
          <button class="btn-revoke-session" onclick="revokeDeviceSession('${s.sessionId}')">Revoke</button>
        `;
        container.appendChild(item);
      });
    });
  };

  // ── Starred Messages, Backups & Exports txt ──
  window.exportActiveChatHistory = function () {
    if (!currentChatId) {
      showToast('No active conversation to export', 'warning');
      return;
    }

    db.collection('chats').doc(currentChatId).collection('messages')
      .orderBy('createdAt', 'asc').get().then(snapshot => {
        let txt = `ChatVibe Conversation Export\nChat ID: ${currentChatId}\nExported: ${new Date().toLocaleString()}\n\n`;
        snapshot.forEach(doc => {
          const m = doc.data();
          const sender = m.senderName || m.senderId;
          const time = m.createdAt ? (m.createdAt.toDate ? m.createdAt.toDate().toLocaleString() : new Date(m.createdAt).toLocaleString()) : '';
          txt += `[${time}] ${sender}: ${m.text || `[Attachment: ${m.type}]`}\n`;
        });

        // Trigger file download
        const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `chatvibe_export_${currentChatId}.txt`;
        link.click();
        showToast('Chat history exported successfully', 'success');
      });
  };

  // JSON backups
  window.backupAllChats = async function () {
    const user = getCurrentUser();
    if (!user) return;

    showToast('Preparing backup JSON file...', 'info');
    try {
      const snapshot = await db.collection('chats').where('participants', 'array-contains', user.uid).get();
      const backupData = [];

      for (const chatDoc of snapshot.docs) {
        const messagesSnap = await chatDoc.ref.collection('messages').orderBy('createdAt', 'asc').get();
        const messages = [];
        messagesSnap.forEach(mDoc => {
          const mData = mDoc.data();
          // Convert firestore timestamps for JSON compatibility
          if (mData.createdAt && mData.createdAt.toDate) mData.createdAt = mData.createdAt.toDate().getTime();
          messages.push(mData);
        });

        backupData.push({
          chatId: chatDoc.id,
          meta: chatDoc.data(),
          messages: messages
        });
      }

      const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `chatvibe_backup_${user.phone}_${Date.now()}.json`;
      link.click();
      showToast('Full backup generated successfully', 'success');
    } catch (e) {
      showToast('Backup generation failed', 'error');
    }
  };

  // Restore active chats
  window.restoreAllChats = function (event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const backupData = JSON.parse(e.target.result);
        showToast('Restoring conversation database...', 'info');

        for (const chat of backupData) {
          const chatRef = db.collection('chats').doc(chat.chatId);
          await chatRef.set(chat.meta, { merge: true });

          for (const m of chat.messages) {
            // Restore date object format
            if (m.createdAt) m.createdAt = new Date(m.createdAt);
            await chatRef.collection('messages').add(m);
          }
        }
        showToast('Backup restored successfully!', 'success');
      } catch (err) {
        showToast('Restoration failed: Invalid JSON file', 'error');
      }
    };
    reader.readAsText(file);
  };

  // Expose local state variables
  window.getCurrentChatId = () => currentChatId;
  window.getCurrentContactUid = () => currentContactUid;
  window.getCachedContacts = () => cachedContacts;
  window.getChatId = getChatId;
  window.getInitials = getInitials;
  window.isFreshPresence = isFreshPresence;
  window.switchChatFilter = (filter) => {
    activeChatFilter = filter;
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.id === 'tab' + filter.charAt(0).toUpperCase() + filter.slice(1) + 'Chats' || btn.id === 'tab' + filter.charAt(0).toUpperCase() + filter.slice(1));
    });
    if (window.filterContacts) {
      window.filterContacts();
    }
  };

})();
