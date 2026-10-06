(function (global) {
  'use strict';

  var chatAfterId = '';
  var commentsVideoId = '';
  var commentsRequestId = 0;
  var chatTimer = null;
  var chatLoaded = false;
  var currentUserId = '';
  var currentUserPromise = Promise.resolve();

  function $(selector) { return document.querySelector(selector); }

  function escapeText(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  async function jsonFetch(url, options) {
    var response = await fetch(url, Object.assign({ credentials: 'same-origin' }, options || {}));
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  function setStatus(selector, message, isError) {
    var element = $(selector);
    element.textContent = message || '';
    element.classList.toggle('is-error', Boolean(isError));
  }

  function openDialog(id) {
    var dialog = $('#' + id);
    if (dialog && !dialog.open) dialog.showModal();
  }

  function closeDialog(id) {
    var dialog = $('#' + id);
    if (dialog && dialog.open) dialog.close();
  }

  function setAvatar(url, displayName) {
    var topButton = $('#profile-button');
    var fallback = $('#profile-avatar-fallback');
    var preview = $('#profile-avatar-preview');
    var letter = String(displayName || 'U').trim().charAt(0).toUpperCase() || 'U';
    if (fallback) fallback.textContent = letter;
    var topFallback = topButton.querySelector('.profile-avatar-fallback');
    if (topFallback) topFallback.textContent = letter;
    if (url) {
      preview.src = url;
      preview.hidden = false;
      fallback.hidden = true;
      var image = document.createElement('img');
      image.src = url;
      image.alt = '';
      topButton.replaceChildren(image);
    } else {
      preview.hidden = true;
      fallback.hidden = false;
      topButton.innerHTML = '<span class="profile-avatar-fallback">' + escapeText(letter) + '</span>';
    }
  }

  async function loadProfile() {
    var data = await jsonFetch('/api/me/profile');
    $('#profile-display-name').value = data.profile.displayName || data.profile.username;
    $('#profile-bio').value = data.profile.bio || '';
    setAvatar(data.profile.avatarUrl, data.profile.displayName || data.profile.username);
    renderWarnings(data.warnings || []);
    await loadHistory();
  }

  function renderWarnings(warnings) {
    var root = $('#profile-warnings-list');
    if (!warnings.length) {
      root.innerHTML = '<p class="history-empty">No account notices.</p>';
      return;
    }
    root.innerHTML = warnings.slice().reverse().map(function (warning) {
      return '<div class="warning-item ' + (warning.readAt ? '' : 'unread') + '">' +
        '<span>' + escapeText(warning.message) + '</span>' +
        (!warning.readAt ? '<button type="button" data-read-warning="' + escapeText(warning.id) + '">Mark read</button>' : '') +
      '</div>';
    }).join('');
  }

  async function loadHistory() {
    var data = await jsonFetch('/api/me/history');
    renderHistory('watch', data.history || []);
    renderHistory('search', data.history || []);
  }

  function renderHistory(type, history) {
    var items = history.filter(function (item) { return item.type === type; }).slice(0, 100);
    var root = type === 'watch' ? $('#watch-history-list') : $('#search-history-list');
    if (!items.length) {
      root.innerHTML = '<p class="history-empty">No ' + (type === 'watch' ? 'watch' : 'search') + ' history yet.</p>';
      return;
    }
    root.innerHTML = items.map(function (item) {
      var label = item.title || item.value;
      var href = type === 'watch' ? '#/watch/' + encodeURIComponent(item.value) : '#/search/' + encodeURIComponent(item.value);
      return '<div class="history-item"><a href="' + href + '">' + escapeText(label) + '</a>' +
        '<time>' + escapeText(new Date(item.createdAt).toLocaleDateString()) + '</time></div>';
    }).join('');
  }

  function createCommunityItem(item) {
    var row = document.createElement('article');
    row.className = 'community-item';
    if (item.author && item.author.avatarUrl) {
      var avatar = document.createElement('img');
      avatar.src = item.author.avatarUrl;
      avatar.alt = '';
      avatar.onerror = function () { avatar.remove(); };
      row.appendChild(avatar);
    }
    var body = document.createElement('div');
    body.className = 'community-item-body';
    var head = document.createElement('div');
    head.className = 'community-item-head';
    var author = document.createElement('strong');
    author.textContent = item.author && (item.author.displayName || item.author.username) || 'User';
    var time = document.createElement('time');
    time.textContent = new Date(item.createdAt).toLocaleString();
    head.append(author, time);
    var message = document.createElement('p');
    message.textContent = item.message;
    body.append(head, message);
    row.appendChild(body);
    if (item.videoId && currentUserId && item.author && item.author.id === currentUserId) {
      var actions = document.createElement('div');
      actions.className = 'comment-actions';
      ['edit', 'delete'].forEach(function (action) {
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = action === 'edit' ? 'Edit' : 'Delete';
        button.dataset.commentAction = action;
        button.dataset.commentId = item.id;
        actions.appendChild(button);
      });
      row.appendChild(actions);
    }
    return row;
  }

  async function loadChat(initial) {
    var url = '/api/community/chat' + (!initial && chatAfterId ? '?after=' + encodeURIComponent(chatAfterId) : '');
    var data = await jsonFetch(url);
    var root = $('#community-chat-list');
    var shouldScroll = initial || root.scrollHeight - root.scrollTop - root.clientHeight < 80;
    if (initial) root.replaceChildren();
    (data.messages || []).forEach(function (message) {
      if (!initial && root.querySelector('[data-message-id="' + message.id + '"]')) return;
      var row = createCommunityItem(message);
      row.dataset.messageId = message.id;
      root.appendChild(row);
      chatAfterId = message.id;
    });
    if (shouldScroll) root.scrollTop = root.scrollHeight;
    chatLoaded = true;
  }

  async function loadMemes() {
    var data = await jsonFetch('/api/community/memes');
    var root = $('#community-meme-list');
    root.replaceChildren();
    if (!data.memes.length) {
      root.innerHTML = '<p class="history-empty">No memes posted yet.</p>';
      return;
    }
    data.memes.forEach(function (meme) {
      var article = document.createElement('article');
      article.className = 'meme-post';
      var image = document.createElement('img');
      image.src = meme.imageUrl;
      image.alt = meme.caption || 'Community meme';
      var caption = document.createElement('p');
      caption.textContent = meme.caption || '';
      var author = document.createElement('small');
      author.textContent = (meme.author.displayName || meme.author.username) + ' · ' + new Date(meme.createdAt).toLocaleString();
      article.append(image, caption, author);
      root.appendChild(article);
    });
  }

  async function loadComments(videoId) {
    if (!videoId || videoId === commentsVideoId && $('#video-comments-list').dataset.loaded === 'true') return;
    commentsVideoId = videoId;
    var requestId = ++commentsRequestId;
    var root = $('#video-comments-list');
    root.dataset.loaded = 'false';
    root.innerHTML = '<p class="history-empty">Loading comments…</p>';
    $('#comments-status').textContent = '';
    try {
      await currentUserPromise;
      var data = await jsonFetch('/api/videos/' + encodeURIComponent(videoId) + '/comments');
      if (requestId !== commentsRequestId) return;
      root.replaceChildren();
      if (!data.comments.length) {
        root.innerHTML = '<p class="history-empty">Be the first to comment.</p>';
      } else {
        data.comments.forEach(function (comment) { root.appendChild(createCommunityItem(comment)); });
      }
      root.dataset.loaded = 'true';
    } catch (error) {
      if (requestId === commentsRequestId) $('#comments-status').textContent = error.message;
    }
  }

  function selectCommunityTab(name) {
    document.querySelectorAll('[data-community-tab]').forEach(function (button) {
      button.classList.toggle('active', button.dataset.communityTab === name);
    });
    $('#community-chat-tab').hidden = name !== 'chat';
    $('#community-memes-tab').hidden = name !== 'memes';
    if (name === 'memes') loadMemes().catch(function (error) { setStatus('#community-status', error.message, true); });
  }

  function init() {
    currentUserPromise = jsonFetch('/api/auth/me').then(function (data) {
      currentUserId = data.user.id;
    }).catch(function () {});

    $('#profile-button').addEventListener('click', function () {
      openDialog('profile-dialog');
      loadProfile().catch(function (error) { setStatus('#profile-status', error.message, true); });
    });
    $('#community-button').addEventListener('click', function () {
      openDialog('community-dialog');
      if (!chatLoaded) loadChat(true).catch(function (error) { setStatus('#community-status', error.message, true); });
      if (!chatTimer) chatTimer = setInterval(function () {
        if ($('#community-dialog').open && !$('#community-chat-tab').hidden) loadChat(false).catch(function (error) { setStatus('#community-status', error.message, true); });
      }, 2500);
    });
    document.querySelectorAll('[data-close-dialog]').forEach(function (button) {
      button.addEventListener('click', function () { closeDialog(button.dataset.closeDialog); });
    });
    document.querySelectorAll('[data-community-tab]').forEach(function (button) {
      button.addEventListener('click', function () { selectCommunityTab(button.dataset.communityTab); });
    });

    $('#profile-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      try {
        var data = await jsonFetch('/api/me/profile', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            displayName: $('#profile-display-name').value,
            bio: $('#profile-bio').value
          })
        });
        setAvatar(data.profile.avatarUrl, data.profile.displayName);
        setStatus('#profile-status', 'Profile saved.');
      } catch (error) { setStatus('#profile-status', error.message, true); }
    });

    $('#profile-avatar-input').addEventListener('change', async function () {
      var file = this.files && this.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) return setStatus('#profile-status', 'Choose an image smaller than 5 MB.', true);
      var body = new FormData();
      body.append('image', file);
      try {
        var data = await jsonFetch('/api/me/profile/avatar', { method: 'POST', body: body });
        setAvatar(data.avatarUrl, $('#profile-display-name').value);
        setStatus('#profile-status', 'Profile picture updated.');
      } catch (error) { setStatus('#profile-status', error.message, true); }
      this.value = '';
    });

    document.body.addEventListener('click', async function (event) {
      var clearButton = event.target.closest('[data-clear-history]');
      if (clearButton) {
        try {
          await jsonFetch('/api/me/history?type=' + encodeURIComponent(clearButton.dataset.clearHistory), { method: 'DELETE' });
          await loadHistory();
          setStatus('#profile-status', 'History cleared.');
        } catch (error) { setStatus('#profile-status', error.message, true); }
      }
      var warningButton = event.target.closest('[data-read-warning]');
      if (warningButton) {
        try {
          await jsonFetch('/api/me/warnings/' + encodeURIComponent(warningButton.dataset.readWarning) + '/read', { method: 'PATCH' });
          await loadProfile();
        } catch (error) { setStatus('#profile-status', error.message, true); }
      }
      var historyLink = event.target.closest('.history-item a');
      if (historyLink) closeDialog('profile-dialog');
      var cancelEdit = event.target.closest('[data-comment-cancel-edit]');
      if (cancelEdit) {
        var editRow = cancelEdit.closest('.community-item');
        editRow.querySelector('.community-item-body p').hidden = false;
        editRow.querySelector('.comment-edit-form').remove();
        editRow.querySelector('.comment-actions').hidden = false;
        return;
      }
      var saveEdit = event.target.closest('[data-comment-save-edit]');
      if (saveEdit) {
        var saveRow = saveEdit.closest('.community-item');
        var saveVideoId = commentsVideoId;
        var saveCommentId = saveEdit.dataset.commentId;
        var updatedMessage = saveRow.querySelector('.comment-edit-input').value.trim();
        if (!updatedMessage) return;
        saveEdit.disabled = true;
        try {
          await jsonFetch('/api/videos/' + encodeURIComponent(saveVideoId) + '/comments/' + encodeURIComponent(saveCommentId), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: updatedMessage })
          });
          if (commentsVideoId === saveVideoId) {
            $('#video-comments-list').dataset.loaded = 'false';
            await loadComments(saveVideoId);
          }
        } catch (error) { $('#comments-status').textContent = error.message; saveEdit.disabled = false; }
        return;
      }
      var commentDeleteCancel = event.target.closest('[data-comment-cancel-delete]');
      if (commentDeleteCancel) {
        var deleteActions = commentDeleteCancel.closest('.comment-actions');
        var deleteButton = deleteActions.querySelector('[data-comment-action="delete"]');
        deleteButton.textContent = 'Delete';
        deleteButton.dataset.confirmDelete = '';
        commentDeleteCancel.remove();
        return;
      }
      var commentButton = event.target.closest('[data-comment-action]');
      if (commentButton) {
        var commentId = commentButton.dataset.commentId;
        var videoId = commentsVideoId;
        var commentRow = commentButton.closest('.community-item');
        if (commentButton.dataset.commentAction === 'edit') {
          if (commentRow.querySelector('.comment-edit-form')) return;
          var messageNode = commentRow.querySelector('.community-item-body p');
          messageNode.hidden = true;
          commentButton.closest('.comment-actions').hidden = true;
          var form = document.createElement('form');
          form.className = 'comment-edit-form';
          var input = document.createElement('textarea');
          input.className = 'comment-edit-input';
          input.maxLength = 1000;
          input.value = messageNode.textContent;
          var saveButton = document.createElement('button');
          saveButton.type = 'button';
          saveButton.textContent = 'Save';
          saveButton.dataset.commentSaveEdit = '';
          saveButton.dataset.commentId = commentId;
          var cancelButton = document.createElement('button');
          cancelButton.type = 'button';
          cancelButton.textContent = 'Cancel';
          cancelButton.dataset.commentCancelEdit = '';
          form.append(input, saveButton, cancelButton);
          commentRow.querySelector('.community-item-body').appendChild(form);
          input.focus();
          return;
        }
        if (!commentButton.dataset.confirmDelete) {
          commentButton.dataset.confirmDelete = 'true';
          commentButton.textContent = 'Confirm delete';
          var cancelDelete = document.createElement('button');
          cancelDelete.type = 'button';
          cancelDelete.textContent = 'Cancel';
          cancelDelete.dataset.commentCancelDelete = '';
          commentButton.after(cancelDelete);
          return;
        }
        commentButton.disabled = true;
        try {
          await jsonFetch('/api/videos/' + encodeURIComponent(videoId) + '/comments/' + encodeURIComponent(commentId), { method: 'DELETE' });
        } catch (error) { $('#comments-status').textContent = error.message; commentButton.disabled = false; return; }
        if (commentsVideoId === videoId) {
          $('#video-comments-list').dataset.loaded = 'false';
          await loadComments(videoId);
        }
      }
    });

    $('#community-chat-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      var input = $('#community-chat-input');
      var message = input.value.trim();
      if (!message) return;
      try {
        var data = await jsonFetch('/api/community/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: message })
        });
        input.value = '';
        var root = $('#community-chat-list');
        var row = createCommunityItem(data.message);
        row.dataset.messageId = data.message.id;
        root.appendChild(row);
        chatAfterId = data.message.id;
        root.scrollTop = root.scrollHeight;
      } catch (error) { setStatus('#community-status', error.message, true); }
    });

    $('#video-comment-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      var message = $('#video-comment-input').value.trim();
      if (!commentsVideoId || !message) return;
      try {
        await jsonFetch('/api/videos/' + encodeURIComponent(commentsVideoId) + '/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: message })
        });
        $('#video-comment-input').value = '';
        $('#video-comments-list').dataset.loaded = 'false';
        await loadComments(commentsVideoId);
      } catch (error) { $('#comments-status').textContent = error.message; }
    });

    $('#meme-upload-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      var file = $('#meme-image-input').files && $('#meme-image-input').files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) return setStatus('#community-status', 'Choose an image smaller than 5 MB.', true);
      var body = new FormData();
      body.append('image', file);
      body.append('caption', $('#meme-caption-input').value);
      try {
        await jsonFetch('/api/community/memes', { method: 'POST', body: body });
        $('#meme-upload-form').reset();
        setStatus('#community-status', 'Meme posted.');
        await loadMemes();
      } catch (error) { setStatus('#community-status', error.message, true); }
    });
  }

  global.StreamCommunity = {
    init: init,
    loadComments: loadComments,
    trackHistory: function (type, value, title) {
      if (!value) return;
      fetch('/api/me/history', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: type, value: value, title: title || '' })
      }).catch(function () {});
    }
  };
})(window);
