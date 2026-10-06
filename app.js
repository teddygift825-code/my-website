/**
 * Freedom Journey frontend
 * --------------------
 * Hash router + catalog UI. Every interaction stays in the SAME tab:
 * video clicks go through StreamEngine.play() (inline iframe swap),
 * window.open() and target="_blank" links are blocked by design.
 */
(function () {
  'use strict';

  var catalog = { channels: [] };
  var searchResults = [];
  var searchQuery = '';
  var searchLoading = false;
  var searchPageToken = 0;
  var searchSource = 'catalog';
  var searchVariants = [];
  var searchVariantIndex = 0;
  var homeFeed = { token: 0, query: '', loading: false, ids: new Set(), variants: [], variantIndex: 0 };
  var watchFeed = { videoId: '', token: 0, loading: false, ids: new Set(), variants: [], variantIndex: 0, videos: [] };
  var watchStateKey = 'freedom_journey_watch_state';
  var restoredWatchState = readSavedWatchState();
  var pendingResume = null;

  var relatedSearchTerms = [
    'mix', 'playlist', 'live', 'compilation', 'best of', 'highlights', 'clips',
    'full video', 'official', 'interview', 'behind the scenes', 'reaction',
    'cover', 'remix', 'top videos', 'similar videos', 'radio', 'extended',
    'documentary', 'popular'
  ];

  function makeSearchVariants(query) {
    return [query].concat(relatedSearchTerms.map(function (term) {
      return query + ' ' + term;
    })).map(function (value) {
      return { query: value, cursor: null, exhausted: false };
    });
  }

  function nextSearchVariant(feed) {
    for (var attempt = 0; attempt < feed.variants.length; attempt += 1) {
      var variant = feed.variants[feed.variantIndex % feed.variants.length];
      feed.variantIndex += 1;
      if (!variant.exhausted) return variant;
    }
    return null;
  }

  function hasSearchVariants(feed) {
    return feed.variants.some(function (variant) { return !variant.exhausted; });
  }

  function readSavedWatchState() {
    try {
      var saved = JSON.parse(sessionStorage.getItem(watchStateKey) || 'null');
      if (!saved || !saved.current || !saved.current.id) return null;
      if (!saved.savedAt || Date.now() - saved.savedAt > 24 * 60 * 60 * 1000) {
        sessionStorage.removeItem(watchStateKey);
        return null;
      }
      return saved;
    } catch (err) { return null; }
  }

  function saveWatchState() {
    if (!StreamEngine) return;
    var current = StreamEngine.getCurrent();
    if (!current) return;
    var state = {
      current: current,
      queue: StreamEngine.getQueue(),
      position: StreamEngine.getCurrentTime(),
      autoplay: StreamEngine.isAutoplay(),
      wasPlaying: StreamEngine.getState() === StreamEngine.states.PLAYING || StreamEngine.getState() === StreamEngine.states.BUFFERING,
      related: watchFeed.videoId === current.id ? watchFeed.videos : [],
      savedAt: Date.now()
    };
    try { sessionStorage.setItem(watchStateKey, JSON.stringify(state)); } catch (err) { /* storage may be full or disabled */ }
  }

  function restoreWatchState() {
    if (!restoredWatchState || !restoredWatchState.current) return;
    var current = restoredWatchState.current;
    var queue = Array.isArray(restoredWatchState.queue) && restoredWatchState.queue.length
      ? restoredWatchState.queue
      : [current];
    var currentIndex = queue.findIndex(function (video) { return video.id === current.id; });
    StreamEngine.setQueue(queue, currentIndex < 0 ? 0 : currentIndex);
    StreamEngine.setAutoplay(restoredWatchState.autoplay !== false);
    watchFeed.videos = Array.isArray(restoredWatchState.related) ? restoredWatchState.related : [];
    pendingResume = {
      id: current.id,
      position: Number(restoredWatchState.position) || 0,
      wasPlaying: restoredWatchState.wasPlaying !== false,
      applied: false
    };
    StreamEngine.play(current.id, current);
  }

  function startWatchRecommendations(video, queue, force) {
    if (!video || !video.id || (!force && watchFeed.videoId === video.id)) return;
    watchFeed.videoId = video.id;
    watchFeed.token += 1;
    watchFeed.loading = false;
    watchFeed.variants = makeSearchVariants([video.title, video.channel].filter(Boolean).join(' '));
    watchFeed.variantIndex = 0;
    watchFeed.ids = new Set([video.id]);
    watchFeed.videos = [];
    var results = $('#watch-recommendation-results');
    results.innerHTML = '';
    var savedRelated = restoredWatchState && restoredWatchState.current && restoredWatchState.current.id === video.id
      ? restoredWatchState.related || []
      : [];
    (queue || []).concat(savedRelated).forEach(function (item) {
      if (!item.id || watchFeed.ids.has(item.id)) return;
      watchFeed.ids.add(item.id);
      watchFeed.videos.push(item);
      results.appendChild(videoCard(item));
    });
    $('#watch-recommendations-status').textContent = results.children.length
      ? results.children.length + ' videos from your current channel or search · finding more'
      : 'Finding related videos…';
    var button = $('#watch-recommendation-more');
    button.hidden = !hasSearchVariants(watchFeed);
    button.disabled = true;
    button.textContent = 'Finding more videos…';
    loadWatchRecommendations(watchFeed.token, true);
  }

  function updateWatchRecommendationButton(token) {
    var button = $('#watch-recommendation-more');
    if (token !== watchFeed.token) return;
    button.hidden = !hasSearchVariants(watchFeed);
    button.disabled = false;
    button.textContent = 'Load more videos';
  }

  function loadWatchRecommendations(token, initial) {
    if (watchFeed.loading || token !== watchFeed.token) return;
    watchFeed.loading = true;
    var button = $('#watch-recommendation-more');
    if (!initial) {
      button.hidden = false;
      button.disabled = true;
      button.textContent = 'Loading…';
    }

    function requestPage(remaining, firstPage) {
      if (token !== watchFeed.token) return Promise.resolve();
      var variant = firstPage ? watchFeed.variants[0] : nextSearchVariant(watchFeed);
      if (!variant) return Promise.resolve();
      var query = variant.cursor
        ? 'cursor=' + encodeURIComponent(variant.cursor)
        : 'q=' + encodeURIComponent(variant.query);
      return fetch('/api/search?' + query)
        .then(function (response) { return response.json(); })
        .then(function (data) {
          if (token !== watchFeed.token) return;
          if (data.error) throw new Error(data.error);
          if (firstPage && data.source === 'youtube' && !data.fallback) {
            watchFeed.variants = [variant];
          }
          var freshVideos = (data.videos || []).filter(function (item) {
            if (watchFeed.ids.has(item.id)) return false;
            watchFeed.ids.add(item.id);
            return true;
          });
          variant.emptyPages = freshVideos.length ? 0 : (variant.emptyPages || 0) + 1;
          variant.cursor = data.nextCursor || null;
          if (!variant.cursor || variant.emptyPages >= 2) variant.exhausted = true;
          freshVideos.forEach(function (item) {
            watchFeed.videos.push(item);
            $('#watch-recommendation-results').appendChild(videoCard(item));
          });
          var total = $('#watch-recommendation-results').children.length;
          $('#watch-recommendations-status').textContent = total
            ? total + ' related videos' + (data.source === 'youtube' ? ' · YouTube' : ' · built-in catalog')
            : 'No related videos found yet.';
          if (remaining > 1 && hasSearchVariants(watchFeed)) return requestPage(remaining - 1, false);
        });
    }

    requestPage(initial ? 1 : 20, initial)
      .then(function () { updateWatchRecommendationButton(token); })
      .catch(function () {
        if (token !== watchFeed.token) return;
        $('#watch-recommendations-status').textContent = 'Could not load related videos. Try again.';
        button.hidden = false;
        button.disabled = false;
        button.textContent = 'Retry loading videos';
      })
      .finally(function () {
        if (token === watchFeed.token) watchFeed.loading = false;
      });
  }
  var logoutStarted = false;
  var banLogoutTimer = null;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function thumb(id) { return 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg'; }

  function withInfo(ch, v) {
    return Object.assign({ channelId: ch.id, channel: ch.name, category: ch.category }, v);
  }

  /* ==================== SAME-TAB GUARANTEES ==================== */

  // 1) Popups are never allowed.
  window.open = function (url) {
    console.warn('[Freedom Journey] window.open() blocked — playback stays in this tab.', url);
    return null;
  };

  // 2) Links that target a new tab/window are never allowed.
  document.addEventListener('click', function (e) {
    var link = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!link) return;

    if (link.hasAttribute('target')) {
      e.preventDefault();
      console.warn('[Freedom Journey] blocked a new-tab link:', link.href);
      return;
    }

    // 3) Plain YouTube watch links are intercepted and played inline.
    var href = link.getAttribute('href') || '';
    var m = href.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,20})/);
    if (m && href.charAt(0) !== '#') {
      e.preventDefault();
      go('#/watch/' + m[1]);
    }
  });

  /* ==================== Navigation ==================== */

  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  function showView(id) {
    $$('.view').forEach(function (v) { v.hidden = v.id !== id; });
    $('#empty-state').hidden = true;
    updateNowPlaying();
  }

  function findVideo(id) {
    var hit = null;
    (catalog.channels || []).some(function (ch) {
      var list = (ch.videos || []).map(function (v) { return withInfo(ch, v); });
      var idx = list.findIndex(function (v) { return v.id === id; });
      if (idx !== -1) {
        hit = { video: list[idx], queue: list, index: idx, channel: ch };
        return true;
      }
      return false;
    });
    if (hit) return hit;

    var sIdx = searchResults.findIndex(function (v) { return v.id === id; });
    if (sIdx !== -1) {
      return { video: searchResults[sIdx], queue: searchResults.slice(), index: sIdx, channel: null };
    }
    if (restoredWatchState && Array.isArray(restoredWatchState.queue)) {
      var savedIndex = restoredWatchState.queue.findIndex(function (video) { return video.id === id; });
      if (savedIndex !== -1) {
        return { video: restoredWatchState.queue[savedIndex], queue: restoredWatchState.queue.slice(), index: savedIndex, channel: null };
      }
    }
    return null;
  }

  /* ==================== Rendering ==================== */

  function videoCard(v) {
    var a = document.createElement('a');
    a.className = 'card';
    a.href = '#/watch/' + v.id;
    a.innerHTML =
      '<div class="thumb">' +
        '<img loading="lazy" alt="" src="' + esc(v.thumbnail || thumb(v.id)) + '" ' +
        'onerror=\'this.style.visibility="hidden"\'>' +
        (v.live ? '<span class="badge badge-live">LIVE</span>' : '') +
      '</div>' +
      '<div class="card-body">' +
        '<h3>' + esc(v.title || 'Untitled') + '</h3>' +
        '<p>' + esc(v.channel || '') + '</p>' +
      '</div>';
    return a;
  }

  function renderHome() {
    var channels = catalog.channels || [];

    // Channel chips
    var chips = $('#channel-chips');
    chips.innerHTML = '';
    channels.forEach(function (ch) {
      var a = document.createElement('a');
      a.className = 'chip';
      a.href = '#/channel/' + ch.id;
      a.textContent = ch.name;
      chips.appendChild(a);
    });

    // Hero: first live or featured video
    var heroVideo = null;
    channels.forEach(function (ch) {
      (ch.videos || []).forEach(function (v) {
        if (!heroVideo && (v.live || v.featured)) heroVideo = withInfo(ch, v);
      });
    });
    if (!heroVideo && channels[0] && (channels[0].videos || []).length) {
      heroVideo = withInfo(channels[0], channels[0].videos[0]);
    }

    var hero = $('#hero');
    hero.innerHTML = '';
    var promoVideos = [];
    channels.forEach(function (channel) {
      var sample = (channel.videos || []).find(function (video) { return !heroVideo || video.id !== heroVideo.id; });
      if (sample && promoVideos.length < 4) promoVideos.push(withInfo(channel, sample));
    });
    hero.hidden = false;
    hero.innerHTML =
      '<div class="hero-collage" aria-hidden="true">' +
        promoVideos.map(function (video) {
          return '<img alt="" src="' + esc(video.thumbnail || thumb(video.id)) + '">';
        }).join('') +
      '</div>' +
      '<div class="hero-content">' +
        '<span class="hero-tag">FREEDOM JOURNEY</span>' +
        '<h1>Find your next favorite.</h1>' +
        '<p>Live streams, music, films, and creators in one place.</p>' +
        '<button class="btn btn-primary" type="button" data-hero-search>Explore videos</button>' +
      '</div>';

    // Channel sections
    var wrap = $('#home-sections');
    wrap.innerHTML = '';
    channels.forEach(function (ch) {
      if (!ch.videos || !ch.videos.length) return;
      var sec = document.createElement('section');
      sec.className = 'section';
      sec.innerHTML =
        '<div class="section-head">' +
          '<h2>' + esc(ch.name) + '</h2>' +
          '<span class="section-sub">' + esc(ch.description || ch.category || '') + '</span>' +
          '<a class="see-all" href="#/channel/' + ch.id + '">See all »</a>' +
        '</div>';
      var row = document.createElement('div');
      row.className = 'grid';
      ch.videos.forEach(function (v) { row.appendChild(videoCard(withInfo(ch, v))); });
      sec.appendChild(row);
      wrap.appendChild(sec);
    });
    startHomeRecommendations(heroVideo);
  }

  function startHomeRecommendations(seedVideo) {
    var section = $('#home-recommendations');
    if (!seedVideo) {
      section.hidden = true;
      return;
    }
    homeFeed.token += 1;
    homeFeed.query = seedVideo.title || seedVideo.channel || seedVideo.category || '';
    homeFeed.variants = makeSearchVariants(homeFeed.query);
    homeFeed.variantIndex = 0;
    homeFeed.loading = false;
    homeFeed.ids = new Set();
    homeFeed.ids.add(seedVideo.id);
    (catalog.channels || []).forEach(function (channel) {
      (channel.videos || []).forEach(function (video) { homeFeed.ids.add(video.id); });
    });
    $('#home-recommendation-results').innerHTML = '';
    $('#home-recommendation-more').hidden = true;
    $('#home-recommendation-sub').textContent = 'Finding videos related to ' + (seedVideo.title || seedVideo.channel || 'your channels');
    section.hidden = false;
    loadHomeRecommendations(homeFeed.token, true);
  }

  function observeHomeRecommendations(token) {
    var button = $('#home-recommendation-more');
    if (!hasSearchVariants(homeFeed)) {
      button.hidden = true;
      return;
    }
    button.hidden = false;
    button.disabled = false;
    button.textContent = 'Load more videos';
  }

  function loadHomeRecommendations(token, initial) {
    if (homeFeed.loading || token !== homeFeed.token) return;
    homeFeed.loading = true;
    var button = $('#home-recommendation-more');
    if (!initial && !button.hidden) {
      button.disabled = true;
      button.textContent = 'Loading…';
    }
    function requestPage(remaining, initialPage) {
      if (token !== homeFeed.token) return Promise.resolve();
      var variant = initialPage ? homeFeed.variants[0] : nextSearchVariant(homeFeed);
      if (!variant) return Promise.resolve();
      var query = variant.cursor
        ? 'cursor=' + encodeURIComponent(variant.cursor)
        : 'q=' + encodeURIComponent(variant.query);
      return fetch('/api/search?' + query)
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (token !== homeFeed.token) return;
          if (data.error) throw new Error(data.error);
          if (initialPage && !data.fallback) {
            homeFeed.variants = [variant];
          }
          var results = data.videos || [];
          var videos = results.filter(function (video) {
            if (homeFeed.ids.has(video.id)) return false;
            homeFeed.ids.add(video.id);
            return true;
          });
          variant.emptyPages = videos.length ? 0 : (variant.emptyPages || 0) + 1;
          variant.cursor = data.nextCursor || null;
          if (!variant.cursor || variant.emptyPages >= 2) variant.exhausted = true;
          videos.forEach(function (video) { $('#home-recommendation-results').appendChild(videoCard(video)); });
          $('#home-recommendation-sub').textContent =
            $('#home-recommendation-results').children.length + ' related videos' +
            (data.source === 'youtube' ? ' · YouTube' : ' · built-in catalog');
          if (remaining > 1 && hasSearchVariants(homeFeed)) return requestPage(remaining - 1, false);
        });
    }

    requestPage(initial ? 1 : 20, initial)
      .then(function () {
        if (token === homeFeed.token) observeHomeRecommendations(token);
      })
      .catch(function () {
        if (token !== homeFeed.token) return;
        $('#home-recommendation-sub').textContent = 'Could not load related videos.';
        if (!initial) {
          homeFeed.variantIndex = (homeFeed.variantIndex - 1 + homeFeed.variants.length) % homeFeed.variants.length;
          button.disabled = false;
          button.textContent = 'Retry loading videos';
          button.hidden = false;
        }
      })
      .finally(function () {
        if (token === homeFeed.token) homeFeed.loading = false;
      });
  }
  /* ==================== Views ==================== */

  function showChannel(channelId) {
    var ch = (catalog.channels || []).find(function (c) { return c.id === channelId; });
    if (!ch) {
      showView('view-home');
      $('#empty-state').textContent = 'Channel not found.';
      $('#empty-state').hidden = false;
      return;
    }

    var videos = (ch.videos || []).map(function (v) { return withInfo(ch, v); });
    var view = $('#view-channel');
    view.innerHTML =
      '<div class="channel-banner">' +
        '<div class="cb-icon">▶</div>' +
        '<div><h1>' + esc(ch.name) + '</h1><p>' + esc(ch.description || ch.category || '') + '</p></div>' +
      '</div>' +
      '<div class="section-head"><h2>All videos</h2>' +
      '<span class="section-sub">' + videos.length + ' video' + (videos.length === 1 ? '' : 's') +
      (ch.category ? ' · ' + esc(ch.category) : '') + '</span></div>';

    var grid = document.createElement('div');
    grid.className = 'grid';
    videos.forEach(function (v) { grid.appendChild(videoCard(v)); });
    view.appendChild(grid);

    showView('view-channel');
    document.title = ch.name + ' — Freedom Journey';
  }

  function showSearch(q) {
    showView('view-search');
    searchQuery = q || '';
    if (searchQuery) StreamCommunity.trackHistory('search', searchQuery, searchQuery);
    searchResults = [];
    searchVariants = makeSearchVariants(searchQuery);
    searchVariantIndex = 0;
    searchLoading = false;
    var token = ++searchPageToken;
    $('#search-more').hidden = true;
    $('#search-more').disabled = false;
    $('#search-input').value = q || '';
    $('#search-heading').textContent = q ? 'Results for “' + q + '”' : 'All videos';
    $('#search-sub').textContent = 'Searching…';
    $('#search-results').innerHTML = '';
    $('#empty-state').textContent = 'Nothing found. Try a different search.';
    document.title = (q ? q + ' — search' : 'Search') + ' — Freedom Journey';

    loadSearchPage(token, true);
  }

  function observeSearchMore(token) {
    var button = $('#search-more');
    if (!hasSearchVariants({ variants: searchVariants })) {
      button.hidden = true;
      return;
    }
    button.hidden = false;
    button.disabled = false;
    button.textContent = 'Load more results';
  }

  function loadSearchPage(token, initial) {
    if (searchLoading || token !== searchPageToken) return;
    searchLoading = true;
    var button = $('#search-more');
    if (!initial && !button.hidden) {
      button.disabled = true;
      button.textContent = 'Loading…';
    }
    var searchFeed = { variants: searchVariants, variantIndex: searchVariantIndex };
    function requestPage(remaining, initialPage) {
      if (token !== searchPageToken) return Promise.resolve();
      var variant = initialPage ? searchVariants[0] : nextSearchVariant(searchFeed);
      if (!initialPage) searchVariantIndex = searchFeed.variantIndex;
      if (!variant) return Promise.resolve();
      var query = variant.cursor
        ? 'cursor=' + encodeURIComponent(variant.cursor)
        : 'q=' + encodeURIComponent(variant.query);
      return fetch('/api/search?' + query)
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (token !== searchPageToken) return;
          if (data.error) throw new Error(data.error);
          if (initialPage && !data.fallback) {
            searchVariants = [variant];
            searchFeed.variants = searchVariants;
          }
          var seen = new Set(searchResults.map(function (video) { return video.id; }));
          var videos = (data.videos || []).filter(function (video) {
            if (seen.has(video.id)) return false;
            seen.add(video.id);
            return true;
          });
          variant.emptyPages = videos.length ? 0 : (variant.emptyPages || 0) + 1;
          variant.cursor = data.nextCursor || null;
          if (!variant.cursor || variant.emptyPages >= 2) variant.exhausted = true;
          searchResults = searchResults.concat(videos);
          searchSource = data.source || searchSource;
          $('#search-sub').textContent =
            searchResults.length + ' result' + (searchResults.length === 1 ? '' : 's') +
            (searchSource === 'youtube' ? ' · YouTube' : ' · built-in catalog');
          if (!searchResults.length) {
            $('#empty-state').hidden = hasSearchVariants(searchFeed);
          } else {
            $('#empty-state').hidden = true;
            var grid = $('#search-results');
            videos.forEach(function (video) { grid.appendChild(videoCard(video)); });
          }
          if (remaining > 1 && hasSearchVariants(searchFeed)) return requestPage(remaining - 1, false);
        });
    }

    requestPage(initial ? 1 : 20, initial)
      .then(function () {
        if (token === searchPageToken) observeSearchMore(token);
      })
      .catch(function () {
        if (token !== searchPageToken) return;
        if (initial) $('#search-sub').textContent = 'Search failed — is the server running?';
        else {
          searchVariantIndex = (searchFeed.variantIndex - 1 + searchVariants.length) % searchVariants.length;
          button.disabled = false;
          button.textContent = 'Retry loading results';
          button.hidden = false;
        }
      })
      .finally(function () {
        if (token === searchPageToken) searchLoading = false;
      });
  }

  function showWatch(id) {
    showView('view-watch');
    var found = findVideo(id);

    if (found) {
      applyWatch(found.video, found.queue, found.index);
      return;
    }

    // Unknown id (e.g. typed URL): resolve metadata WITHOUT leaving the tab.
    var video = { id: id, title: 'Loading…', channel: '', live: false };
    applyWatch(video, [video], 0);
    fetch('/api/video/' + encodeURIComponent(id))
      .then(function (r) { return r.json(); })
      .then(function (meta) {
        if (!meta.found) {
          $('#watch-title').textContent = 'Unknown video';
          $('#watch-channel').textContent = 'This video id is not in the catalog.';
          return;
        }
        video.title = meta.title || video.title;
        video.channel = meta.channel || video.channel;
        video.thumbnail = meta.thumbnail || video.thumbnail;
        $('#watch-title').textContent = video.title;
        $('#watch-channel').textContent = video.channel;
        renderQueue([video], 0);
        startWatchRecommendations(video, [video], true);
        updateNowPlaying();
      })
      .catch(function () { /* player error overlay handles failures */ });
  }

  function applyWatch(video, queue, index) {
    $('#watch-title').textContent = video.title || 'Untitled';
    $('#watch-channel').textContent =
      (video.channel || '') + (video.category ? ' · ' + video.category : '');
    renderQueue(queue, index);
    StreamEngine.setQueue(queue, index);
    var current = StreamEngine.getCurrent();
    if (!current || current.id !== video.id) {
      StreamCommunity.trackHistory('watch', video.id, video.title);
      StreamEngine.play(video.id, video);
    }
    StreamCommunity.loadComments(video.id);
    startWatchRecommendations(video, queue);
    document.title = (video.title || 'Watch') + ' — Freedom Journey';
  }

  function renderQueue(queue, activeIndex) {
    var list = $('#queue-list');
    list.innerHTML = '';
    queue.forEach(function (v, i) {
      var el = document.createElement('div');
      el.className = 'queue-item' + (i === activeIndex ? ' active' : '');
      el.dataset.id = v.id;
      el.innerHTML =
        '<div class="qi-thumb"><img loading="lazy" alt="" src="' +
          esc(v.thumbnail || thumb(v.id)) + '"></div>' +
        '<div class="qi-text"><h4>' + esc(v.title || 'Untitled') + '</h4>' +
        '<p>' + esc(v.channel || '') + '</p></div>';
      el.addEventListener('click', function () { go('#/watch/' + v.id); });
      list.appendChild(el);
    });
  }

  function highlightQueue(id) {
    $$('#queue-list .queue-item').forEach(function (el) {
      el.classList.toggle('active', el.dataset.id === id);
    });
  }
  /* ==================== Routing ==================== */

  function route() {
    var hash = location.hash || '#/';
    var raw = hash.replace(/^#\/?/, '');
    var parts = raw.split('/');
    var head = parts[0] || '';

    if (head === 'watch' && parts[1]) return showWatch(decodeURIComponent(parts[1]));
    if (head === 'channel' && parts[1]) return showChannel(decodeURIComponent(parts[1]));
    if (head === 'search') return showSearch(decodeURIComponent(parts.slice(1).join('/')));

    showHome();
  }

  function showHome() {
    showView('view-home');
    document.title = 'Freedom Journey — Streaming Channels';
  }

  /* ==================== Now-playing bar ==================== */

  function updateNowPlaying() {
    var bar = $('#now-playing');
    var cur = StreamEngine.getCurrent();
    if (!cur) { bar.hidden = true; return; }
    $('#np-title').textContent = cur.title || cur.id;
    $('#np-live').hidden = !cur.live;
    var watchVisible = !$('#view-watch').hidden;
    bar.hidden = watchVisible; // only visible while browsing away from the player
  }

  /* ==================== Engine wiring ==================== */

  function wireEngine() {
    StreamEngine.on('video', function (meta) {
      updateNowPlaying();
      if (!$('#view-watch').hidden) {
        $('#watch-title').textContent = meta.title || meta.id;
        $('#watch-channel').textContent = meta.channel || '';
        highlightQueue(meta.id);
      }
      if (meta.title) document.title = meta.title + ' — Freedom Journey';
      saveWatchState();
    });

    StreamEngine.on('state', function (s) {
      $('#np-toggle').innerHTML = s.name === 'PLAYING' ? '❚❚' : '▶';
      if (!$('#view-watch').hidden && s.video) highlightQueue(s.video.id);
      if (pendingResume && !pendingResume.applied && s.video && s.video.id === pendingResume.id &&
          (s.name === 'PLAYING' || s.name === 'PAUSED' || s.name === 'CUED')) {
        pendingResume.applied = true;
        var resume = pendingResume;
        setTimeout(function () {
          var current = StreamEngine.getCurrent();
          if (current && current.id === resume.id) {
            if (resume.position > 1) StreamEngine.seekTo(resume.position);
            if (!resume.wasPlaying) StreamEngine.pause();
            else StreamEngine.resume();
            pendingResume = null;
            saveWatchState();
          }
        }, 350);
      } else {
        saveWatchState();
      }
    });

    StreamEngine.on('error', function (err) {
      $('#player-error-text').textContent = err.message;
      $('#player-error').hidden = false;
    });

    StreamEngine.on('error-clear', function () { $('#player-error').hidden = true; });
    StreamEngine.on('ready', function () { $('#player-error').hidden = true; });
    StreamEngine.on('stopped', function () {
      $('#now-playing').hidden = true;
      restoredWatchState = null;
      pendingResume = null;
      try { sessionStorage.removeItem(watchStateKey); } catch (err) { /* storage may be disabled */ }
    });
  }

  /* ==================== Controls ==================== */

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  function wireControls() {
    // Search (stays in this tab)
    $('#search-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var q = $('#search-input').value.trim();
      if (q) go('#/search/' + encodeURIComponent(q));
    });
    document.addEventListener('click', function (event) {
      if (event.target.closest('[data-hero-search]')) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        $('#search-input').focus({ preventScroll: true });
      }
    });
    $('#search-more').addEventListener('click', function () {
      loadSearchPage(searchPageToken, false);
    });
    $('#home-recommendation-more').addEventListener('click', function () {
      loadHomeRecommendations(homeFeed.token, false);
    });
    $('#watch-recommendation-more').addEventListener('click', function () {
      loadWatchRecommendations(watchFeed.token, false);
    });

    $('#report-button').addEventListener('click', function () {
      $('#report-status').textContent = '';
      $('#report-dialog').showModal();
    });
    $('#report-form').addEventListener('submit', function (event) {
      event.preventDefault();
      var type = $('#report-type').value;
      var details = $('#report-details').value.trim();
      if (!details) return;
      var current = StreamEngine.getCurrent();
      var subject = 'Freedom Journey report: ' + type;
      var body = [
        'Report type: ' + type,
        'Details: ' + details,
        'Page: ' + location.href,
        current ? 'Playing video: ' + (current.title || current.id) + ' (' + current.id + ')' : ''
      ].filter(Boolean).join('\n\n');
      var mailto = 'mailto:teddygift825@gmail.com?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
      $('#report-status').textContent = 'Opening your email app with the report addressed to teddygift825@gmail.com.';
      var link = document.createElement('a');
      link.href = mailto;
      link.click();
    });

    $('#logout-button').addEventListener('click', endSession);

    // Now-playing bar
    $('#np-toggle').addEventListener('click', function () { StreamEngine.toggle(); });
    $('#np-return').addEventListener('click', function () {
      var cur = StreamEngine.getCurrent();
      if (cur) go('#/watch/' + cur.id);
    });
    $('#np-stop').addEventListener('click', function () { StreamEngine.stop(); });

    // Autoplay "up next"
    $('#autoplay-toggle').addEventListener('change', function (e) {
      StreamEngine.setAutoplay(e.target.checked);
    });

    // Copy video link instead of opening a new tab
    $('#copy-link-btn').addEventListener('click', function () {
      var cur = StreamEngine.getCurrent();
      if (!cur) return;
      var url = 'https://youtu.be/' + cur.id;
      var done = function () {
        var b = $('#copy-link-btn');
        b.textContent = 'Copied!';
        setTimeout(function () { b.textContent = 'Copy video link'; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done).catch(function () { fallbackCopy(url); done(); });
      } else {
        fallbackCopy(url);
        done();
      }
    });

    // Keyboard shortcuts for the same-tab player
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
                t.tagName === 'SELECT' || t.isContentEditable)) return;
      if ($('#view-watch').hidden) return;
      switch (e.key) {
        case ' ': e.preventDefault(); StreamEngine.toggle(); break;
        case 'ArrowRight': e.preventDefault(); StreamEngine.seekBy(10); break;
        case 'ArrowLeft': e.preventDefault(); StreamEngine.seekBy(-10); break;
        case 'f': case 'F': StreamEngine.fullscreen(); break;
        case 'n': case 'N': StreamEngine.next(); break;
        case 'p': case 'P': StreamEngine.previous(); break;
      }
    });
  }

  function endSession() {
    if (logoutStarted) return;
    logoutStarted = true;
    if (banLogoutTimer) clearTimeout(banLogoutTimer);
    StreamEngine.stop();
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', keepalive: true })
      .finally(function () { window.location.replace('/login'); });
  }

  function checkSession() {
    fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) {
        if (res.status === 401) {
          endSession();
          return null;
        }
        if (!res.ok) {
          if (res.status !== 403) return null;
          return res.json().then(function (data) {
            if (data.banned && data.error) {
              try { sessionStorage.setItem('streamvault_ban_notice', data.error); } catch (err) { /* storage may be disabled */ }
              endSession();
            }
            return null;
          });
        }
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.user || !data.user.banned || logoutStarted) return;
        if (data.banNotice) {
          try { sessionStorage.setItem('streamvault_ban_notice', data.banNotice); } catch (err) { /* storage may be disabled */ }
        }
        if (banLogoutTimer) return;
        var expiresAt = Number(data.banExpiresAt);
        if (!Number.isFinite(expiresAt)) return endSession();
        banLogoutTimer = setTimeout(endSession, Math.max(0, expiresAt - Date.now()));
      })
      .catch(function () {});
  }

  /* ==================== Boot ==================== */

  function boot() {
    wireEngine();
    wireControls();
    StreamCommunity.init();
    window.addEventListener('hashchange', route);
    window.addEventListener('beforeunload', saveWatchState);
    checkSession();
    setInterval(checkSession, 1000);
    setInterval(saveWatchState, 2000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkSession();
    });

    // Warm up the single persistent player as early as possible.
    StreamEngine.mount('yt-player').catch(function (err) {
      $('#player-error-text').textContent = err.message;
      $('#player-error').hidden = false;
    });

    fetch('/api/channels')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        catalog = data && data.channels ? data : { channels: [] };
        renderHome();
        restoreWatchState();
        route();
      })
      .catch(function () {
        $('#home-sections').innerHTML =
          '<div class="empty-state">Could not load the channel catalog. Is the server running?</div>';
        route();
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();


