// ============================================================
// Calls Module
// WebRTC audio/video calls with Firestore signaling.
// Supports making, receiving, and managing calls.
// ============================================================

(function () {
  'use strict';

  const getCurrentUser = () => window.getCurrentUser ? window.getCurrentUser() : null;
  const showToast = (msg, type) => window.showToast ? window.showToast(msg, type) : console.log(msg);

  // ── WebRTC Configuration ──
  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  };

  // ── State ──
  let peerConnection = null;
  let localStream = null;
  let remoteStream = null;
  let callDoc = null;
  let callType = null; // 'audio' | 'video'
  let isCaller = false;
  let isMuted = false;
  let isCamOff = false;
  let callTimerInterval = null;
  let callStartTime = null;
  let callListenerUnsubscribe = null;
  let activeCallUnsubscribe = null;
  let callerCandidatesUnsubscribe = null;
  let receiverCandidatesUnsubscribe = null;
  let ringtoneAudio = null;
  let activeIncomingCallId = null;

  // ── Initialize call listener (listens for incoming calls) ──
  window.initCallListener = function () {
    const user = getCurrentUser();
    if (!user) return;

    if (callListenerUnsubscribe) callListenerUnsubscribe();

    callListenerUnsubscribe = db.collection('calls')
      .where('receiverId', '==', user.uid)
      .onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
          const callData = { id: change.doc.id, ...change.doc.data() };
          if ((change.type === 'added' || change.type === 'modified') && callData.status === 'ringing' && callData.offer) {
            if (activeIncomingCallId !== callData.id) {
              showIncomingCall(callData);
            }
          } else if (activeIncomingCallId === callData.id && callData.status !== 'ringing') {
            document.getElementById('incomingCall')?.classList.remove('show');
            activeIncomingCallId = null;
          }
        });
      }, (error) => {
        console.error('[Call] Incoming listener failed:', error);
        showToast('Call listener failed: ' + error.message, 'error');
      });
  };

  // ── Make a call ──
  window.makeCall = async function (type) {
    const user = getCurrentUser();
    const contact = window._currentContact;
    if (!user || !contact) {
      showToast('Select a contact first', 'error');
      return;
    }
    if (contact.isGroup) {
      showToast('Calls are available in direct chats only', 'warning');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('Microphone/camera is not available in this browser or connection', 'error');
      return;
    }

    callType = type;
    isCaller = true;

    try {
      // Get media stream
      const constraints = {
        audio: true,
        video: type === 'video'
      };
      localStream = await navigator.mediaDevices.getUserMedia(constraints);

      // Show call UI
      showCallUI(contact, type, 'Calling...');
      startRingtone(false); // Play outgoing call sound

      if (type === 'video') {
        document.getElementById('localVideo').srcObject = localStream;
      }

      // Create call document in Firestore
      const callRef = db.collection('calls').doc();
      callDoc = callRef;

      await callRef.set({
        callerId: user.uid,
        callerPhone: user.phone,
        receiverId: contact.uid,
        type: type,
        status: 'ringing',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      // Create peer connection
      peerConnection = new RTCPeerConnection(rtcConfig);

      // Add local tracks
      localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
      });

      // Handle remote stream
      remoteStream = new MediaStream();
      peerConnection.ontrack = (event) => {
        event.streams[0].getTracks().forEach(track => {
          remoteStream.addTrack(track);
        });

        attachRemoteStream(remoteStream);
      };

      // ICE candidates — caller side
      const callerCandidates = callRef.collection('callerCandidates');
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          callerCandidates.add(event.candidate.toJSON());
        }
      };

      // Create offer
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      await callRef.update({
        offer: { type: offer.type, sdp: offer.sdp }
      });

      // Listen for answer
      activeCallUnsubscribe = callRef.onSnapshot(async (snapshot) => {
        const data = snapshot.data();
        if (!data) return;

        // Call answered
        if (data.answer && !peerConnection.currentRemoteDescription) {
          const answer = new RTCSessionDescription(data.answer);
          await peerConnection.setRemoteDescription(answer);

          // Call connected
          onCallConnected(contact, type);
        }

        // Call ended by other party
        if (data.status === 'ended' || data.status === 'declined') {
          endCallCleanup();
          if (data.status === 'declined') {
            showToast('Call declined', 'info');
          }
        }
      });

      // Listen for receiver ICE candidates
      receiverCandidatesUnsubscribe = callRef.collection('receiverCandidates').onSnapshot((snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
          if (change.type === 'added') {
            const candidate = new RTCIceCandidate(change.doc.data());
            if (peerConnection) await peerConnection.addIceCandidate(candidate);
          }
        });
      });

      // Auto-cancel after 45 seconds if not answered
      setTimeout(() => {
        if (callDoc && !callStartTime) {
          callRef.update({ status: 'missed' });
          endCallCleanup();
          showToast('No answer', 'info');
        }
      }, 45000);

    } catch (error) {
      console.error('[Call] Error making call:', error);
      endCallCleanup();

      if (error.name === 'NotAllowedError') {
        showToast('Microphone/camera permission denied', 'error');
      } else {
        showToast('Call failed: ' + error.message, 'error');
      }
    }
  };

  // ── Show incoming call notification ──
  function showIncomingCall(callData) {
    const incomingEl = document.getElementById('incomingCall');
    const callerName = callData.callerPhone || 'Unknown';
    const initials = window.getInitials ? getInitials(callerName) : '??';
    activeIncomingCallId = callData.id;

    document.getElementById('callerAvatar').textContent = initials;
    document.getElementById('callerName').textContent = callerName;
    document.getElementById('callerType').textContent =
      callData.type === 'video' ? 'Incoming video call...' : 'Incoming audio call...';

    incomingEl.classList.add('show');
    startRingtone(true); // Play incoming ringtone

    // Accept button
    document.getElementById('acceptCallBtn').onclick = () => {
      incomingEl.classList.remove('show');
      activeIncomingCallId = null;
      stopRingtone();
      acceptCall(callData);
    };

    // Decline button
    document.getElementById('declineCallBtn').onclick = () => {
      incomingEl.classList.remove('show');
      activeIncomingCallId = null;
      stopRingtone();
      db.collection('calls').doc(callData.id).update({ status: 'declined' });
    };

    // Auto-dismiss after 45 seconds
    setTimeout(() => {
      incomingEl.classList.remove('show');
      if (activeIncomingCallId === callData.id) activeIncomingCallId = null;
    }, 45000);
  }

  // ── Accept incoming call ──
  async function acceptCall(callData) {
    callType = callData.type;
    isCaller = false;
    stopRingtone();

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showToast('Microphone/camera is not available in this browser or connection', 'error');
        return;
      }

      const constraints = {
        audio: true,
        video: callData.type === 'video'
      };
      localStream = await navigator.mediaDevices.getUserMedia(constraints);

      // Find contact info
      const callerDoc = await db.collection('users').doc(callData.callerId).get();
      const callerInfo = callerDoc.exists ? callerDoc.data() : { phoneNumber: callData.callerPhone };

      showCallUI(callerInfo, callData.type, 'Connecting...');

      if (callData.type === 'video') {
        document.getElementById('localVideo').srcObject = localStream;
      }

      callDoc = db.collection('calls').doc(callData.id);

      // Create peer connection
      peerConnection = new RTCPeerConnection(rtcConfig);

      // Add local tracks
      localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
      });

      // Handle remote stream
      remoteStream = new MediaStream();
      peerConnection.ontrack = (event) => {
        event.streams[0].getTracks().forEach(track => {
          remoteStream.addTrack(track);
        });

        attachRemoteStream(remoteStream);
      };

      // ICE candidates — receiver side
      const receiverCandidates = callDoc.collection('receiverCandidates');
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          receiverCandidates.add(event.candidate.toJSON());
        }
      };

      // Set remote description (the offer)
      const callSnapshot = await callDoc.get();
      const offer = callSnapshot.data().offer;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

      // Create answer
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      await callDoc.update({
        answer: { type: answer.type, sdp: answer.sdp },
        status: 'connected'
      });

      // Listen for caller ICE candidates
      callerCandidatesUnsubscribe = callDoc.collection('callerCandidates').onSnapshot((snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
          if (change.type === 'added') {
            const candidate = new RTCIceCandidate(change.doc.data());
            if (peerConnection) await peerConnection.addIceCandidate(candidate);
          }
        });
      });

      // Call connected
      onCallConnected(callerInfo, callData.type);

      // Listen for call end
      activeCallUnsubscribe = callDoc.onSnapshot((snapshot) => {
        const data = snapshot.data();
        if (data && data.status === 'ended') {
          endCallCleanup();
        }
      });

    } catch (error) {
      console.error('[Call] Error accepting call:', error);
      endCallCleanup();

      if (error.name === 'NotAllowedError') {
        showToast('Microphone/camera permission denied', 'error');
      } else {
        showToast('Failed to answer call', 'error');
      }
    }
  }

  // ── Call connected ──
  function onCallConnected(contact, type) {
    callStartTime = Date.now();
    stopRingtone();

    document.getElementById('callStatusText').textContent = 'Connected';
    document.getElementById('callAvatar').classList.remove('ringing');

    if (type === 'video') {
      document.getElementById('callOverlay').classList.remove('show');
      document.getElementById('videoContainer').classList.add('show');
    }

    // Start timer
    callTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
      const min = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const sec = String(elapsed % 60).padStart(2, '0');
      document.getElementById('callTimer').textContent = `${min}:${sec}`;
    }, 1000);
  }

  function attachRemoteStream(stream) {
    const remoteVideo = document.getElementById('remoteVideo');
    if (!remoteVideo) return;
    if (remoteVideo.srcObject !== stream) {
      remoteVideo.srcObject = stream;
    }
    remoteVideo.play().catch(() => {});
  }

  // ── Show call UI ──
  function showCallUI(contact, type, statusText) {
    const displayName = contact.displayName || contact.phoneNumber || 'Unknown';
    const initials = window.getInitials ? getInitials(contact.phoneNumber || displayName) : '??';

    document.getElementById('callAvatar').textContent = initials;
    document.getElementById('callAvatar').classList.add('ringing');
    document.getElementById('callName').textContent = displayName;
    document.getElementById('callStatusText').textContent = statusText;
    document.getElementById('callTimer').textContent = '';
    document.getElementById('callOverlay').classList.add('show');
  }

  // ── End call ──
  window.endCall = async function () {
    if (callDoc) {
      try {
        await callDoc.update({ status: 'ended' });
      } catch (e) {
        console.warn('[Call] Could not update call status:', e);
      }
    }
    endCallCleanup();
  };

  function endCallCleanup() {
    stopRingtone();
    if (activeCallUnsubscribe) {
      activeCallUnsubscribe();
      activeCallUnsubscribe = null;
    }
    if (callerCandidatesUnsubscribe) {
      callerCandidatesUnsubscribe();
      callerCandidatesUnsubscribe = null;
    }
    if (receiverCandidatesUnsubscribe) {
      receiverCandidatesUnsubscribe();
      receiverCandidatesUnsubscribe = null;
    }
    // Stop media tracks
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = null;
    }

    // Close peer connection
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }

    // Reset state
    remoteStream = null;
    callDoc = null;
    isCaller = false;
    isMuted = false;
    isCamOff = false;
    callStartTime = null;

    if (callTimerInterval) {
      clearInterval(callTimerInterval);
      callTimerInterval = null;
    }

    // Hide UI
    document.getElementById('callOverlay').classList.remove('show');
    document.getElementById('videoContainer').classList.remove('show');
    document.getElementById('incomingCall').classList.remove('show');
    activeIncomingCallId = null;

    // Clear video elements
    document.getElementById('localVideo').srcObject = null;
    document.getElementById('remoteVideo').srcObject = null;

    // Reset button states
    updateMuteBtn(false);
    updateCamBtn(false);
  }

  // ── Toggle mute ──
  window.toggleMute = function () {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(track => {
      track.enabled = !isMuted;
    });
    updateMuteBtn(isMuted);
  };

  function updateMuteBtn(muted) {
    const icon = muted ? '🔇' : '🎙️';
    const btns = ['toggleMuteBtn', 'vToggleMuteBtn'];
    btns.forEach(id => {
      const btn = document.getElementById(id);
      if (btn) {
        btn.textContent = icon;
        btn.classList.toggle('active', muted);
      }
    });
  }

  // ── Toggle camera ──
  window.toggleCamera = function () {
    if (!localStream) return;
    isCamOff = !isCamOff;
    localStream.getVideoTracks().forEach(track => {
      track.enabled = !isCamOff;
    });
    updateCamBtn(isCamOff);
  };

  function updateCamBtn(off) {
    const icon = off ? '🚫' : '📷';
    const btns = ['toggleCamBtn', 'vToggleCamBtn'];
    btns.forEach(id => {
      const btn = document.getElementById(id);
      if (btn) {
        btn.textContent = icon;
        btn.classList.toggle('active', off);
      }
    });
  }

  // ── Web Audio API Ringtone Synth ──
  let audioCtx = null;
  let ringtoneInterval = null;

  function startRingtone(isIncoming) {
    try {
      if (audioCtx) stopRingtone();
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      
      let isPlaying = false;
      ringtoneInterval = setInterval(() => {
        if (isPlaying) return;
        isPlaying = true;
        
        if (isIncoming) {
          playIncomingSound();
          setTimeout(() => { isPlaying = false; }, 2000);
        } else {
          playOutgoingSound();
          setTimeout(() => { isPlaying = false; }, 3000);
        }
      }, 500);
    } catch (e) {
      console.warn('[Call] Could not start ringtone:', e);
    }
  }

  function playIncomingSound() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const notes = [880, 1100, 1320, 880, 1100, 1320];
    notes.forEach((freq, idx) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.15);
      gain.gain.setValueAtTime(0, now + idx * 0.15);
      gain.gain.linearRampToValueAtTime(0.2, now + idx * 0.15 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.15 + 0.13);
      
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now + idx * 0.15);
      osc.stop(now + idx * 0.15 + 0.14);
    });
  }

  function playOutgoingSound() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const osc1 = audioCtx.createOscillator();
    const osc2 = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(440, now);
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(480, now);
    
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.1, now + 0.1);
    gain.gain.setValueAtTime(0.1, now + 1.2);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.4);
    
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(audioCtx.destination);
    
    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 1.5);
    osc2.stop(now + 1.5);
  }

  function stopRingtone() {
    if (ringtoneInterval) {
      clearInterval(ringtoneInterval);
      ringtoneInterval = null;
    }
    if (audioCtx) {
      try {
        audioCtx.close();
      } catch (e) {}
      audioCtx = null;
    }
  }

})();
