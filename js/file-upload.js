// ============================================================
// File Upload & Media Controller
// Handles file uploading to Firebase Storage, image compression,
// voice recording, and waveform visualizers.
// ============================================================

(function () {
  'use strict';

  const getCurrentChatId = () => window.getCurrentChatId ? window.getCurrentChatId() : null;
  const getCurrentUser = () => window.getCurrentUser ? window.getCurrentUser() : null;
  const showToast = (msg, type) => window.showToast ? window.showToast(msg, type) : console.log(msg);

  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB limit

  // ── Image Compression using HTML5 Canvas ──
  function compressImage(file) {
    return new Promise((resolve) => {
      try {
        if (!file || !file.type || !file.type.startsWith('image/')) {
          resolve(file);
          return;
        }

        const reader = new FileReader();
        reader.onerror = () => resolve(file);
        reader.onload = function (event) {
          try {
            const img = new Image();
            img.onerror = () => resolve(file);
            img.onload = function () {
              try {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                // Resize constraints: max 1200px
                const MAX_WIDTH = 1200;
                const MAX_HEIGHT = 1200;

                if (width > height) {
                  if (width > MAX_WIDTH) {
                    height *= MAX_WIDTH / width;
                    width = MAX_WIDTH;
                  }
                } else {
                  if (height > MAX_HEIGHT) {
                    width *= MAX_HEIGHT / height;
                    height = MAX_HEIGHT;
                  }
                }

                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                // Compress to JPEG with 0.75 quality
                canvas.toBlob((blob) => {
                  try {
                    if (blob) {
                      const compressedFile = new File([blob], (file.name || 'image').replace(/\.[^/.]+$/, "") + ".jpg", {
                        type: 'image/jpeg',
                        lastModified: Date.now()
                      });
                      console.log(`[Compression] Reduced size from ${(file.size / 1024).toFixed(1)}KB to ${(compressedFile.size / 1024).toFixed(1)}KB`);
                      resolve(compressedFile);
                    } else {
                      resolve(file);
                    }
                  } catch (e) {
                    resolve(file);
                  }
                }, 'image/jpeg', 0.75);
              } catch (e) {
                resolve(file);
              }
            };
            img.src = event.target.result;
          } catch (e) {
            resolve(file);
          }
        };
        reader.readAsDataURL(file);
      } catch (e) {
        resolve(file);
      }
    });
  }

  // ── Upload a file to Firebase Storage ──
  window.uploadFile = async function (file, chatId) {
    // Compress first if image
    let uploadTarget = file;
    if (file && file.type && file.type.startsWith('image/')) {
      try {
        uploadTarget = await compressImage(file);
      } catch (err) {
        console.warn('[Upload] Image compression failed, using original:', err);
        uploadTarget = file;
      }
    }

    return new Promise((resolve, reject) => {
      if (uploadTarget.size > MAX_FILE_SIZE) {
        showToast(`File too large: ${uploadTarget.name} (max 10MB)`, 'error');
        resolve(null);
        return;
      }

      const timestamp = Date.now();
      const safeName = uploadTarget.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `chats/${chatId}/${timestamp}_${safeName}`;
      const ref = storage.ref(path);

      const uploadTask = ref.put(uploadTarget);

      // Track progress in UI
      const progressEl = document.getElementById('uploadProgress');
      const progressBar = document.getElementById('progressBar');
      if (progressEl) progressEl.classList.add('show');

      uploadTask.on('state_changed',
        (snapshot) => {
          const pct = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
          if (progressBar) progressBar.style.width = pct + '%';
        },
        (error) => {
          console.error('[Upload] Error:', error);
          if (progressEl) progressEl.classList.remove('show');
          showToast('Upload failed: ' + uploadTarget.name, 'error');
          reject(error);
        },
        async () => {
          try {
            const url = await uploadTask.snapshot.ref.getDownloadURL();
            if (progressEl) progressEl.classList.remove('show');
            if (progressBar) progressBar.style.width = '0%';

            // Log analytics storage estimate increment
            updateStorageUsageAnalytics(uploadTarget.size);

            resolve(url);
          } catch (error) {
            reject(error);
          }
        }
      );
    });
  };

  // ── Voice Recording implementation ──
  let mediaRecorder = null;
  let audioChunks = [];
  let recordStartTime = 0;
  let recordInterval = null;
  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  let drawVisualId = null;

  window.startVoiceRecording = async function () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('Audio recording is not supported in this browser', 'error');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      recordStartTime = Date.now();

      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunks.push(e.data);
        }
      };

      mediaRecorder.start();

      // Show recording UI overlay
      document.getElementById('voiceRecordingOverlay').classList.add('show');
      updateVoiceTimer(0);

      // Setup audio analyzer for waveform visualizer
      setupVoiceWaveformVisualizer(stream);

      // Timer
      recordInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - recordStartTime) / 1000);
        updateVoiceTimer(elapsed);
      }, 1000);

      // Mark status as recording
      setPresenceRecording(true);

    } catch (err) {
      console.error('[Voice] Mic Access Error:', err);
      showToast('Microphone access denied or unavailable', 'error');
    }
  };

  let recordedAudioBlob = null;
  let voicePreviewInterval = null;

  window.toggleVoiceRecordingPause = function () {
    if (!mediaRecorder) return;
    const btn = document.getElementById('voicePauseBtn');

    if (mediaRecorder.state === 'recording') {
      mediaRecorder.pause();
      btn.textContent = '▶ Resume';
      clearInterval(recordInterval);
      setPresenceRecording(false);
    } else if (mediaRecorder.state === 'paused') {
      mediaRecorder.resume();
      btn.textContent = '⏸ Pause';

      // Resume timer
      const elapsedSoFar = parseTimeInputToSeconds(document.getElementById('voiceRecordingTime').textContent);
      recordStartTime = Date.now() - (elapsedSoFar * 1000);
      recordInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - recordStartTime) / 1000);
        updateVoiceTimer(elapsed);
      }, 1000);

      setPresenceRecording(true);
    }
  };

  window.stopAndPreviewVoiceRecording = function () {
    if (!mediaRecorder) return;

    mediaRecorder.onstop = () => {
      recordedAudioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      const audioUrl = URL.createObjectURL(recordedAudioBlob);

      const previewAudio = document.getElementById('voicePreviewAudio');
      previewAudio.src = audioUrl;

      // Update state containers
      document.getElementById('voiceRecordingActive').style.display = 'none';
      const previewContainer = document.getElementById('voiceRecordingPreview');
      previewContainer.style.display = 'flex';
      previewContainer.classList.remove('hidden');

      // Set duration label once metadata loads
      previewAudio.onloadedmetadata = () => {
        const durationSec = Math.floor(previewAudio.duration || 0);
        const min = Math.floor(durationSec / 60);
        const sec = durationSec % 60;
        document.getElementById('voicePreviewDuration').textContent = `${min}:${String(sec).padStart(2, '0')}`;
      };

      // Reset progress
      document.getElementById('voicePreviewProgress').value = 0;
      document.getElementById('voicePreviewCurrentTime').textContent = '0:00';
    };

    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());

    // Clear live visualizer/timer
    clearInterval(recordInterval);
    cancelAnimationFrame(drawVisualId);
    setPresenceRecording(false);
  };

  window.toggleVoicePreviewPlayback = function () {
    const previewAudio = document.getElementById('voicePreviewAudio');
    const playBtn = document.getElementById('voicePreviewPlayBtn');
    const progress = document.getElementById('voicePreviewProgress');
    const currentTimer = document.getElementById('voicePreviewCurrentTime');

    if (previewAudio.paused) {
      previewAudio.play();
      playBtn.textContent = '⏸';

      voicePreviewInterval = setInterval(() => {
        if (previewAudio.duration) {
          const pct = (previewAudio.currentTime / previewAudio.duration) * 100;
          progress.value = pct;

          const curSec = Math.floor(previewAudio.currentTime);
          const min = Math.floor(curSec / 60);
          const sec = curSec % 60;
          currentTimer.textContent = `${min}:${String(sec).padStart(2, '0')}`;
        }
      }, 100);

      previewAudio.onended = () => {
        clearInterval(voicePreviewInterval);
        playBtn.textContent = '▶';
        progress.value = 0;
        currentTimer.textContent = '0:00';
      };
    } else {
      previewAudio.pause();
      playBtn.textContent = '▶';
      clearInterval(voicePreviewInterval);
    }
  };

  window.seekVoicePreview = function (value) {
    const previewAudio = document.getElementById('voicePreviewAudio');
    if (previewAudio && previewAudio.duration) {
      previewAudio.currentTime = (value / 100) * previewAudio.duration;

      const curSec = Math.floor(previewAudio.currentTime);
      const min = Math.floor(curSec / 60);
      const sec = curSec % 60;
      document.getElementById('voicePreviewCurrentTime').textContent = `${min}:${String(sec).padStart(2, '0')}`;
    }
  };

  window.deleteVoicePreview = function () {
    const previewAudio = document.getElementById('voicePreviewAudio');
    previewAudio.pause();
    previewAudio.src = '';
    clearInterval(voicePreviewInterval);

    cleanupAudioRecording();
    showToast('Voice message discarded', 'info');
  };

  window.sendVoicePreview = async function () {
    if (!recordedAudioBlob) return;

    const voiceFile = new File([recordedAudioBlob], `voice_${Date.now()}.webm`, {
      type: 'audio/webm',
      lastModified: Date.now()
    });

    const currentChatId = getCurrentChatId();
    if (currentChatId && window.sendFileMessage) {
      showToast('Uploading voice message...', 'info');
      await window.sendFileMessage(voiceFile, getCurrentUser().uid, currentChatId, window._replyTarget);
    }

    cleanupAudioRecording();
  };

  window.cancelVoiceRecording = function () {
    if (!mediaRecorder) return;
    mediaRecorder.onstop = null;
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
    cleanupAudioRecording();
    showToast('Voice message discarded', 'info');
  };

  function cleanupAudioRecording() {
    clearInterval(recordInterval);
    if (voicePreviewInterval) clearInterval(voicePreviewInterval);
    cancelAnimationFrame(drawVisualId);

    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }

    mediaRecorder = null;
    audioChunks = [];
    recordedAudioBlob = null;

    // Hide overlay
    document.getElementById('voiceRecordingOverlay').classList.remove('show');

    // Reset internal state elements view
    document.getElementById('voiceRecordingActive').style.display = 'flex';
    const previewContainer = document.getElementById('voiceRecordingPreview');
    previewContainer.style.display = 'none';
    previewContainer.classList.add('hidden');
    document.getElementById('voicePauseBtn').textContent = '⏸ Pause';
    document.getElementById('voicePreviewPlayBtn').textContent = '▶';

    setPresenceRecording(false);
  }

  function updateVoiceTimer(seconds) {
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    document.getElementById('voiceRecordingTime').textContent = `${min}:${String(sec).padStart(2, '0')}`;
  }

  function parseTimeInputToSeconds(timeStr) {
    const parts = timeStr.split(':');
    return parseInt(parts[0]) * 60 + parseInt(parts[1]);
  }

  // Draw mic volume waveform on canvas
  function setupVoiceWaveformVisualizer(stream) {
    const canvas = document.getElementById('voiceWaveformCanvas');
    const ctx = canvas.getContext('2d');

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;

    sourceNode = audioCtx.createMediaStreamSource(stream);
    sourceNode.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function draw() {
      drawVisualId = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      ctx.fillStyle = 'rgba(15, 15, 42, 0.9)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 1.5;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        // Calculate height based on volume
        const barHeight = (dataArray[i] / 255) * canvas.height;
        ctx.fillStyle = 'var(--accent-cyan)';
        ctx.fillRect(x, canvas.height - barHeight, barWidth - 1, barHeight);
        x += barWidth;
      }
    }
    draw();
  }

  // Helper updates presence to "recording voice..."
  function setPresenceRecording(isRec) {
    if (window.setRecordingStatus) {
      window.setRecordingStatus(isRec);
    }
  }

  // ── Pending files state ──
  window._pendingFiles = [];

  window.addPendingFiles = function (fileList) {
    const strip = document.getElementById('filePreviewStrip');
    if (!strip) return;

    for (const file of fileList) {
      if (file.size > MAX_FILE_SIZE) {
        showToast(`File too large: ${file.name} (max 10MB)`, 'error');
        continue;
      }

      const index = window._pendingFiles.length;
      window._pendingFiles.push(file);

      const item = document.createElement('div');
      item.className = 'file-preview-item';
      item.dataset.index = index;

      if (file.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.alt = file.name;
        const reader = new FileReader();
        reader.onload = (e) => { img.src = e.target.result; };
        reader.readAsDataURL(file);
        item.appendChild(img);
      } else {
        const ext = file.name.split('.').pop().toUpperCase() || 'FILE';
        const thumb = document.createElement('div');
        thumb.className = 'file-thumb';
        thumb.innerHTML = `📄<span>${ext}</span>`;
        item.appendChild(thumb);
      }

      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-file';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window._pendingFiles[index] = null;
        item.remove();
        const remaining = window._pendingFiles.filter(f => f !== null);
        if (remaining.length === 0) {
          strip.classList.remove('show');
        }
        if (window._toggleComposerButtons) {
          window._toggleComposerButtons();
        }
      });
      item.appendChild(removeBtn);
      strip.appendChild(item);
    }

    if (window._pendingFiles.filter(f => f !== null).length > 0) {
      strip.classList.add('show');
    }
  };

  window.clearPendingFiles = function () {
    window._pendingFiles = [];
    const strip = document.getElementById('filePreviewStrip');
    if (strip) {
      strip.innerHTML = '';
      strip.classList.remove('show');
    }
    if (window._toggleComposerButtons) {
      window._toggleComposerButtons();
    }
  };

  window.getPendingFiles = function () {
    return window._pendingFiles.filter(f => f !== null);
  };

  // Helper to accumulate storage usage in analytics dashboard
  function updateStorageUsageAnalytics(bytes) {
    let current = parseInt(localStorage.getItem('chatvibe_analytics_storage') || '0');
    current += bytes;
    localStorage.setItem('chatvibe_analytics_storage', current.toString());
    if (window.renderAnalyticsDashboard) {
      window.renderAnalyticsDashboard();
    }
  }

})();
