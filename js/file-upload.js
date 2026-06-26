// ============================================================
// File Upload Module
// Handles image/file uploads to Firebase Storage
// with progress tracking and previews.
// ============================================================

(function () {
  'use strict';

  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

  // ── Upload a file to Firebase Storage ──
  window.uploadFile = function (file, chatId) {
    return new Promise((resolve, reject) => {
      if (file.size > MAX_FILE_SIZE) {
        showToast(`File too large: ${file.name} (max 10MB)`, 'error');
        resolve(null);
        return;
      }

      const timestamp = Date.now();
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `chats/${chatId}/${timestamp}_${safeName}`;
      const ref = storage.ref(path);

      const uploadTask = ref.put(file);

      // Show progress
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
          showToast('Upload failed: ' + file.name, 'error');
          reject(error);
        },
        async () => {
          try {
            const url = await uploadTask.snapshot.ref.getDownloadURL();
            if (progressEl) progressEl.classList.remove('show');
            if (progressBar) progressBar.style.width = '0%';
            resolve(url);
          } catch (error) {
            reject(error);
          }
        }
      );
    });
  };

  // ── Pending files state ──
  window._pendingFiles = [];

  // ── Add files to pending list ──
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

      // Remove button
      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-file';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window._pendingFiles[index] = null;
        item.remove();
        // Hide strip if no more files
        const remaining = window._pendingFiles.filter(f => f !== null);
        if (remaining.length === 0) {
          strip.classList.remove('show');
        }
      });
      item.appendChild(removeBtn);

      strip.appendChild(item);
    }

    if (window._pendingFiles.filter(f => f !== null).length > 0) {
      strip.classList.add('show');
    }
  };

  // ── Clear all pending files ──
  window.clearPendingFiles = function () {
    window._pendingFiles = [];
    const strip = document.getElementById('filePreviewStrip');
    if (strip) {
      strip.innerHTML = '';
      strip.classList.remove('show');
    }
  };

  // ── Get pending files (non-null) ──
  window.getPendingFiles = function () {
    return window._pendingFiles.filter(f => f !== null);
  };

})();
