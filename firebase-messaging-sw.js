// ============================================================
// Firebase Cloud Messaging Background Service Worker
// Handles background notifications and user clicks.
// ============================================================

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// Initialize Firebase compat inside the worker context
firebase.initializeApp({
  apiKey:            "AIzaSyDotsT4p39PbnP8eL_8hy7imsRksmv9neo",
  authDomain:        "chat-ce170.firebaseapp.com",
  projectId:         "chat-ce170",
  storageBucket:     "chat-ce170.firebasestorage.app",
  messagingSenderId: "239354855258",
  appId:             "1:239354855258:web:eb050744833b5bb7a8bd63"
});

const messaging = firebase.messaging();

// Handle background notification events
messaging.onBackgroundMessage((payload) => {
  console.log('[ServiceWorker] Background message received:', payload);
  
  const notificationTitle = payload.notification?.title || 'New Message';
  const notificationOptions = {
    body: payload.notification?.body || 'You received a new message.',
    icon: payload.notification?.icon || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">💬</text></svg>',
    badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">💬</text></svg>',
    tag: payload.data?.chatId || 'chatvibe-new-msg',
    renotify: true,
    data: {
      chatId: payload.data?.chatId,
      senderId: payload.data?.senderId
    }
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

// Handle notification click and redirect / focus window
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const chatId = data.chatId;

  if (!chatId) return;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Look for an existing chat window
      for (const client of clientList) {
        if (client.url.includes('chat.html') && 'focus' in client) {
          // Focus the window and send a message to trigger opening the chat
          client.postMessage({ action: 'open_chat', chatId: chatId });
          return client.focus();
        }
      }
      // If no window is open, launch a new one
      if (clients.openWindow) {
        return clients.openWindow(`chat.html?chatId=${chatId}`);
      }
    })
  );
});
