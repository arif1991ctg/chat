const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const db = admin.firestore();

function getMessagePreview(message) {
  if (message.text && message.text.trim()) return message.text.trim();
  if (message.type === 'voice') return 'Voice message';
  if (message.type === 'image') return 'Photo';
  if (message.type === 'video') return 'Video';
  if (message.type === 'file') return message.fileName ? `File: ${message.fileName}` : 'File';
  return 'New message';
}

function getTokenEntries(userData) {
  const entries = [];
  const tokenMap = userData.fcmTokens || {};

  Object.entries(tokenMap).forEach(([key, token]) => {
    if (typeof token === 'string' && token.trim()) {
      entries.push({ key, token });
    }
  });

  if (typeof userData.fcmToken === 'string' && userData.fcmToken.trim()) {
    entries.push({ key: 'legacy', token: userData.fcmToken });
  }

  const seen = new Set();
  return entries.filter((entry) => {
    if (seen.has(entry.token)) return false;
    seen.add(entry.token);
    return true;
  });
}

async function removeInvalidTokens(userRef, tokenEntries, responses) {
  const updates = {};

  responses.forEach((response, index) => {
    if (response.success) return;
    const code = response.error && response.error.code;
    const shouldDelete =
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token';

    if (!shouldDelete) return;

    const entry = tokenEntries[index];
    if (entry.key === 'legacy') {
      updates.fcmToken = admin.firestore.FieldValue.delete();
    } else {
      updates[`fcmTokens.${entry.key}`] = admin.firestore.FieldValue.delete();
    }
  });

  if (Object.keys(updates).length > 0) {
    await userRef.update(updates);
  }
}

exports.sendMessageNotification = functions.firestore
  .document('chats/{chatId}/messages/{messageId}')
  .onCreate(async (snapshot, context) => {
    const message = snapshot.data();
    const { chatId, messageId } = context.params;

    if (!message || !message.senderId) return null;

    const chatSnap = await db.collection('chats').doc(chatId).get();
    if (!chatSnap.exists) return null;

    const chat = chatSnap.data();
    const recipients = (chat.participants || []).filter((uid) => uid !== message.senderId);
    if (recipients.length === 0) return null;

    const senderName = message.senderName || 'Someone';
    const title = chat.isGroup ? `${senderName} in ${chat.name || 'Group'}` : senderName;
    const body = getMessagePreview(message);

    await Promise.all(recipients.map(async (uid) => {
      const userRef = db.collection('users').doc(uid);
      const userSnap = await userRef.get();
      if (!userSnap.exists) return;

      const tokenEntries = getTokenEntries(userSnap.data());
      if (tokenEntries.length === 0) return;

      for (let i = 0; i < tokenEntries.length; i += 500) {
        const chunk = tokenEntries.slice(i, i + 500);
        const response = await admin.messaging().sendEachForMulticast({
          tokens: chunk.map((entry) => entry.token),
          notification: {
            title,
            body
          },
          data: {
            chatId,
            messageId,
            senderId: message.senderId,
            type: message.type || 'text'
          },
          webpush: {
            notification: {
              tag: chatId,
              renotify: true
            },
            fcmOptions: {
              link: `/chat.html?chatId=${encodeURIComponent(chatId)}`
            }
          }
        });

        await removeInvalidTokens(userRef, chunk, response.responses);
      }
    }));

    return null;
  });
