# ChatVibe — Real-Time Chat App

A premium real-time chat application with text messaging, audio/video calls, and file sharing. Built with vanilla HTML/CSS/JS and Firebase.

## Features

- 💬 **Real-time messaging** with read receipts and typing indicators
- 📞 **Audio calls** (WebRTC peer-to-peer)
- 📹 **Video calls** (WebRTC peer-to-peer)
- 📎 **File sharing** — images, documents, any file up to 10MB
- 📷 **Camera capture** — take photos directly (mobile)
- 🌙 **Dark theme** with glassmorphism design
- 📱 **Responsive** — works on PC and mobile
- 🟢 **Online status** — see who's online
- ✓✓ **Read receipts** — know when messages are seen

## Pre-configured Users

| Phone Number   | Password |
|---------------|----------|
| 01822858585   | 123456   |
| 01850821127   | 123456   |

---

## Setup Instructions

### 1. Create a Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click **"Create a project"** → give it a name (e.g., `chatvibe`)
3. Disable Google Analytics (optional) → **Create project**

### 2. Enable Firebase Services

#### Authentication
1. Go to **Build → Authentication → Get Started**
2. Click **Sign-in method** tab
3. Enable **Email/Password** → Save

#### Cloud Firestore
1. Go to **Build → Firestore Database → Create database**
2. Select **Start in test mode** → Next
3. Choose a location → **Enable**

#### Firebase Storage
1. Go to **Build → Storage → Get Started**
2. Click **Start in test mode** → Next → **Done**

### 3. Get Firebase Config

1. Go to **Project Settings** (⚙️ gear icon at top-left)
2. Scroll down to **"Your apps"** section
3. Click the **Web** icon `</>` to add a web app
4. Register the app (name: `ChatVibe`)
5. Copy the **firebaseConfig** object

### 4. Update the App Config

Open `js/firebase-config.js` and replace the placeholder values:

```javascript
const firebaseConfig = {
  apiKey:            "YOUR_ACTUAL_API_KEY",
  authDomain:        "your-project.firebaseapp.com",
  projectId:         "your-project-id",
  storageBucket:     "your-project.firebasestorage.app",
  messagingSenderId: "123456789",
  appId:             "1:123456789:web:abcdef"
};
```

### 5. Create User Accounts

1. Open `setup/seed-users.html` in your browser (or visit it on your deployed site)
2. Click **"Create Users"**
3. Both phone number accounts will be created automatically

### 6. Firestore Security Rules

Go to **Firestore → Rules** and paste:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.uid == userId;
    }
    match /chats/{chatId} {
      allow read, write: if request.auth != null;
      match /messages/{messageId} {
        allow read, write: if request.auth != null;
      }
      match /typing/{userId} {
        allow read, write: if request.auth != null;
      }
    }
    match /calls/{callId} {
      allow read, write: if request.auth != null;
      match /{subcollection}/{docId} {
        allow read, write: if request.auth != null;
      }
    }
  }
}
```

### 7. Storage Security Rules

Go to **Storage → Rules** and paste:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /chats/{chatId}/{allPaths=**} {
      allow read: if request.auth != null;
      allow write: if request.auth != null
                   && request.resource.size < 10 * 1024 * 1024;
    }
  }
}
```

---

## Deployment

### Local Development

```bash
npx serve . -p 3000
```

### Deploy to Vercel

1. Push this project to a GitHub repository
2. Go to [vercel.com](https://vercel.com) → **Import Project**
3. Select your GitHub repo
4. Deploy — done! 🚀

The `vercel.json` is already configured.

---

## Tech Stack

- **Frontend**: Vanilla HTML5, CSS3, JavaScript
- **Backend**: Firebase (Auth, Firestore, Storage)
- **Calls**: WebRTC with Firestore signaling
- **Design**: Dark theme, glassmorphism, Inter font
- **Deploy**: Vercel (static site)
