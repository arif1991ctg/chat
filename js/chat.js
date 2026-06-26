// ============================================================
// Chat Module
// Real-time messaging via Firestore with read receipts,
// typing indicators, and online presence.
// ============================================================

(function () {
  'use strict';

  // ── State ──
  let currentChatId = null;
  let currentContactUid = null;
  let messagesUnsubscribe = null;
  let typingTimeout = null;
  let contactsUnsubscribe = null;
  let lastDateShown = null;

  // ── Generate chat ID (always sorted so it's the same for both users) ──
  function getChatId(uid1, uid2) {
    return [uid1, uid2].sort().join('_');
  }

  // ── Get initials from phone number ──
  function getInitials(phone) {
    if (!phone) return '?';
    const digits = phone.replace(/\D/g, '');
    return digits.slice(-2);
  }

  // ── Format timestamp ──
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

  function formatLastSeen(timestamp) {
    if (!timestamp) return 'Offline';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const now = new Date();
    const diff = (now - date) / 1000;

    if (diff < 60) return 'last seen just now';
    if (diff < 3600) return `last seen ${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `last seen ${Math.floor(diff / 3600)}h ago`;
    return 'last seen ' + date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  // ── Load contacts ──
  let cachedContacts = [];

  window.loadContacts = function () {
    const user = getCurrentUser();
    if (!user) return;

    const contactsList = document.getElementById('contactsList');

    // Listen to all users except current — only subscribe once
    if (contactsUnsubscribe) return; // Already subscribed

    contactsUnsubscribe = db.collection('users')
      .onSnapshot((snapshot) => {
        const contactMap = new Map();
        snapshot.forEach((doc) => {
          const data = { uid: doc.id, ...doc.data() };
          // Skip the current user (by UID or by phone number)
          if (doc.id === user.uid) return;
          if (data.phoneNumber === user.phone) return;
          // Deduplicate by phone number — keep the first seen
          const key = data.phoneNumber || doc.id;
          if (!contactMap.has(key)) {
            contactMap.set(key, data);
          }
        });

        cachedContacts = Array.from(contactMap.values());

        if (cachedContacts.length === 0) {
          contactsList.innerHTML = '<div class="contacts-empty">No contacts yet</div>';
          return;
        }

        renderContacts(cachedContacts, user.uid);
      }, (error) => {
        console.error('[Chat] Error loading contacts:', error);
        contactsList.innerHTML = '<div class="contacts-empty">Error loading contacts</div>';
      });
  };

  // ── Filter contacts by search (client-side) ──
  window.filterContacts = function () {
    const user = getCurrentUser();
    if (!user || cachedContacts.length === 0) return;
    renderContacts(cachedContacts, user.uid);
  };

  // ── Render contact list ──
  function renderContacts(contacts, myUid) {
    const contactsList = document.getElementById('contactsList');
    const searchQuery = (document.getElementById('searchContacts')?.value || '').toLowerCase();

    // Filter by search
    let filtered = contacts;
    if (searchQuery) {
      filtered = contacts.filter(c =>
        (c.phoneNumber || '').toLowerCase().includes(searchQuery) ||
        (c.displayName || '').toLowerCase().includes(searchQuery)
      );
    }

    // For each contact, get last message for preview
    contactsList.innerHTML = '';

    filtered.forEach((contact) => {
      const chatId = getChatId(myUid, contact.uid);
      const item = document.createElement('div');
      item.className = 'contact-item' + (contact.uid === currentContactUid ? ' active' : '');
      item.dataset.uid = contact.uid;
      item.dataset.chatId = chatId;

      const isOnline = contact.online === true;
      const initials = getInitials(contact.phoneNumber || contact.displayName);
      const displayName = contact.displayName || contact.phoneNumber || 'Unknown';

      item.innerHTML = `
        <div class="contact-avatar">
          ${initials}
          <div class="status-dot ${isOnline ? 'online' : ''}"></div>
        </div>
        <div class="contact-details">
          <div class="contact-name">${displayName}</div>
          <div class="contact-last-msg" id="lastMsg_${chatId}">...</div>
        </div>
        <div class="contact-meta">
          <div class="contact-time" id="lastTime_${chatId}"></div>
          <div class="contact-unread" id="unread_${chatId}"></div>
        </div>
      `;

      item.addEventListener('click', () => openChat(contact));
      contactsList.appendChild(item);

      // Load last message preview
      loadLastMessage(chatId, myUid);
    });

    // Store contacts for other modules
    window._contacts = contacts;
  }

  // ── Load last message preview ──
  function loadLastMessage(chatId, myUid) {
    db.collection('chats').doc(chatId).collection('messages')
      .orderBy('createdAt', 'desc')
      .limit(1)
      .onSnapshot((snapshot) => {
        const lastMsgEl = document.getElementById('lastMsg_' + chatId);
        const lastTimeEl = document.getElementById('lastTime_' + chatId);
        if (!lastMsgEl) return;

        if (snapshot.empty) {
          lastMsgEl.textContent = 'Start a conversation';
          return;
        }

        const msg = snapshot.docs[0].data();
        if (msg.type === 'image') {
          lastMsgEl.textContent = '📷 Photo';
        } else if (msg.type === 'file') {
          lastMsgEl.textContent = '📎 ' + (msg.fileName || 'File');
        } else {
          lastMsgEl.textContent = msg.text || '';
        }

        if (msg.createdAt) {
          lastTimeEl.textContent = formatTime(msg.createdAt);
        }

        // Count unread
        loadUnreadCount(chatId, myUid);
      });
  }

  // ── Count unread messages ──
  function loadUnreadCount(chatId, myUid) {
    db.collection('chats').doc(chatId).collection('messages')
      .where('senderId', '!=', myUid)
      .where('seen', '==', false)
      .get()
      .then((snapshot) => {
        const unreadEl = document.getElementById('unread_' + chatId);
        if (unreadEl) {
          unreadEl.textContent = snapshot.size > 0 ? snapshot.size : '';
        }
      })
      .catch(() => {});
  }

  // ── Open a chat ──
  window.openChat = function (contact) {
    const user = getCurrentUser();
    if (!user) return;

    currentContactUid = contact.uid;
    currentChatId = getChatId(user.uid, contact.uid);

    // Update UI
    document.getElementById('noChat').classList.add('hidden');
    document.getElementById('chatHeader').classList.remove('hidden');
    document.getElementById('messagesArea').classList.remove('hidden');
    document.getElementById('messageInputArea').classList.remove('hidden');

    // Set header info
    const initials = getInitials(contact.phoneNumber || contact.displayName);
    const displayName = contact.displayName || contact.phoneNumber || 'Unknown';
    document.getElementById('chatAvatar').textContent = initials;
    document.getElementById('chatName').textContent = displayName;

    const statusEl = document.getElementById('chatStatus');
    if (contact.online) {
      statusEl.textContent = 'Online';
      statusEl.classList.add('online');
    } else {
      statusEl.textContent = formatLastSeen(contact.lastSeen);
      statusEl.classList.remove('online');
    }

    // Watch contact online status
    db.collection('users').doc(contact.uid).onSnapshot((doc) => {
      if (!doc.exists) return;
      const data = doc.data();
      if (data.online) {
        statusEl.textContent = 'Online';
        statusEl.classList.add('online');
      } else {
        statusEl.textContent = formatLastSeen(data.lastSeen);
        statusEl.classList.remove('online');
      }
    });

    // Mark active contact in sidebar
    document.querySelectorAll('.contact-item').forEach(el => {
      el.classList.toggle('active', el.dataset.uid === contact.uid);
    });

    // Mobile: hide sidebar
    const sidebar = document.getElementById('sidebar');
    if (window.innerWidth <= 768) {
      sidebar.classList.add('hidden');
    }

    // Store current contact for calls
    window._currentContact = contact;

    // Ensure chat doc exists
    db.collection('chats').doc(currentChatId).set({
      participants: [user.uid, contact.uid],
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // Load messages
    loadMessages(currentChatId, user.uid);

    // Focus input
    document.getElementById('messageInput').focus();
  };

  // ── Load messages with real-time listener ──
  function loadMessages(chatId, myUid) {
    const messagesArea = document.getElementById('messagesArea');

    // Clear previous listener
    if (messagesUnsubscribe) messagesUnsubscribe();

    // Clear messages (keep typing indicator)
    const typingIndicator = document.getElementById('typingIndicator');
    messagesArea.innerHTML = '';
    messagesArea.appendChild(typingIndicator);
    lastDateShown = null;

    // Listen for messages
    messagesUnsubscribe = db.collection('chats').doc(chatId).collection('messages')
      .orderBy('createdAt', 'asc')
      .onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
            const msg = { id: change.doc.id, ...change.doc.data() };
            appendMessage(msg, myUid, messagesArea, typingIndicator);

            // Mark as seen if from other user
            if (msg.senderId !== myUid && !msg.seen) {
              change.doc.ref.update({ seen: true }).catch(() => {});
            }
          }
          if (change.type === 'modified') {
            // Update seen status
            const msg = { id: change.doc.id, ...change.doc.data() };
            const statusEl = document.querySelector(`[data-msg-id="${msg.id}"] .message-status`);
            if (statusEl && msg.seen) {
              statusEl.textContent = '✓✓';
              statusEl.classList.add('seen');
            }
          }
        });

        // Auto-scroll to bottom
        scrollToBottom(messagesArea);
      }, (error) => {
        console.error('[Chat] Error loading messages:', error);
      });
  }

  // ── Append a single message to the DOM ──
  function appendMessage(msg, myUid, container, typingIndicator) {
    const isSent = msg.senderId === myUid;
    const msgDate = formatDate(msg.createdAt);

    // Insert date separator if needed
    if (msgDate && msgDate !== lastDateShown) {
      lastDateShown = msgDate;
      const sep = document.createElement('div');
      sep.className = 'date-separator';
      sep.innerHTML = `<span>${msgDate}</span>`;
      container.insertBefore(sep, typingIndicator);
    }

    const div = document.createElement('div');
    div.className = `message ${isSent ? 'sent' : 'received'}`;
    div.dataset.msgId = msg.id;

    let content = '';

    // Image message
    if (msg.type === 'image' && msg.fileUrl) {
      content += `<img class="message-image" src="${msg.fileUrl}" alt="Shared image" onclick="openLightbox('${msg.fileUrl}')">`;
    }

    // File message
    if (msg.type === 'file' && msg.fileUrl) {
      const ext = (msg.fileName || '').split('.').pop().toUpperCase() || 'FILE';
      const icon = getFileIcon(ext);
      content += `
        <a class="message-file" href="${msg.fileUrl}" target="_blank" rel="noopener">
          <div class="file-icon">${icon}</div>
          <div class="file-info">
            <div class="file-name">${msg.fileName || 'File'}</div>
            <div class="file-size">${formatFileSize(msg.fileSize || 0)} · ${ext}</div>
          </div>
        </a>`;
    }

    // Text
    if (msg.text) {
      content += `<div class="message-text">${escapeHtml(msg.text)}</div>`;
    }

    const time = formatTime(msg.createdAt);
    const statusIcon = isSent ? (msg.seen ? '✓✓' : '✓') : '';
    const seenClass = msg.seen ? 'seen' : '';

    div.innerHTML = `
      <div class="message-bubble">${content}</div>
      <div class="message-meta">
        <span class="message-time">${time}</span>
        ${isSent ? `<span class="message-status ${seenClass}">${statusIcon}</span>` : ''}
      </div>
    `;

    container.insertBefore(div, typingIndicator);
  }

  // ── Send a text message ──
  window.sendMessage = async function (text, files) {
    const user = getCurrentUser();
    if (!user || !currentChatId) return;

    // Send files first
    if (files && files.length > 0) {
      for (const file of files) {
        await sendFileMessage(file, user.uid, currentChatId);
      }
    }

    // Send text
    if (text && text.trim()) {
      try {
        await db.collection('chats').doc(currentChatId).collection('messages').add({
          senderId: user.uid,
          text: text.trim(),
          type: 'text',
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          seen: false
        });

        // Update chat last message
        await db.collection('chats').doc(currentChatId).update({
          lastMessage: text.trim(),
          lastMessageTime: firebase.firestore.FieldValue.serverTimestamp()
        });
      } catch (error) {
        console.error('[Chat] Error sending message:', error);
        showToast('Failed to send message', 'error');
      }
    }

    // Clear typing status
    clearTypingStatus();
  };

  // ── Send file message ──
  async function sendFileMessage(file, senderId, chatId) {
    const isImage = file.type.startsWith('image/');

    try {
      const url = await window.uploadFile(file, chatId);
      if (!url) return;

      await db.collection('chats').doc(chatId).collection('messages').add({
        senderId: senderId,
        text: '',
        type: isImage ? 'image' : 'file',
        fileUrl: url,
        fileName: file.name,
        fileSize: file.size,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        seen: false
      });

      const preview = isImage ? '📷 Photo' : '📎 ' + file.name;
      await db.collection('chats').doc(chatId).update({
        lastMessage: preview,
        lastMessageTime: firebase.firestore.FieldValue.serverTimestamp()
      });

    } catch (error) {
      console.error('[Chat] Error sending file:', error);
      showToast('Failed to send file: ' + file.name, 'error');
    }
  }

  // ── Typing indicator ──
  window.setTypingStatus = function (isTyping) {
    const user = getCurrentUser();
    if (!user || !currentChatId) return;

    db.collection('chats').doc(currentChatId).collection('typing').doc(user.uid).set({
      isTyping: isTyping,
      timestamp: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});
  };

  function clearTypingStatus() {
    if (typingTimeout) clearTimeout(typingTimeout);
    setTypingStatus(false);
  }

  window.handleTyping = function () {
    setTypingStatus(true);
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => setTypingStatus(false), 2000);
  };

  // Listen for typing from other user
  window.listenForTyping = function (chatId, otherUid) {
    const indicator = document.getElementById('typingIndicator');
    db.collection('chats').doc(chatId).collection('typing').doc(otherUid)
      .onSnapshot((doc) => {
        if (doc.exists && doc.data().isTyping) {
          indicator.classList.add('show');
          scrollToBottom(document.getElementById('messagesArea'));
        } else {
          indicator.classList.remove('show');
        }
      });
  };

  // ── Helpers ──
  function scrollToBottom(el) {
    if (el) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function getFileIcon(ext) {
    const icons = {
      'PDF': '📄', 'DOC': '📝', 'DOCX': '📝',
      'XLS': '📊', 'XLSX': '📊', 'TXT': '📃',
      'ZIP': '🗜️', 'RAR': '🗜️', 'MP4': '🎬',
      'MP3': '🎵', 'WAV': '🎵'
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

  // ── Image lightbox ──
  window.openLightbox = function (url) {
    document.getElementById('lightboxImg').src = url;
    document.getElementById('lightbox').classList.add('show');
  };

  // ── Toast notifications ──
  window.showToast = function (message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(20px)';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  };

  // ── Expose state getters ──
  window.getCurrentChatId = () => currentChatId;
  window.getCurrentContactUid = () => currentContactUid;
  window.getChatId = getChatId;
  window.getInitials = getInitials;

})();
