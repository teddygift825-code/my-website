/**
 * Freedom Journey StreamEngine (v1.0.0)
 * ----------------------------------
 * The streaming engine of the site.
 *
 *  - Loads the official YouTube IFrame API exactly ONCE.
 *  - Keeps ONE persistent <iframe> player instance.
 *  - Swaps videos IN PLACE with loadVideoById(), so playback always happens
 *    inside THIS tab: no window.open(), no target="_blank", no popups.
 *  - Maintains a queue so channels can "up next" autoplay.
 *
 * Usage:
 *   StreamEngine.mount('yt-player').then(() => ...);
 *   StreamEngine.play('VIDEO_ID', { title: '...', channel: '...' });
 *   StreamEngine.on('state', s => ...);
 */
(function (global) {
  'use strict';

  var VERSION = '1.0.0';
  var YT_STATES = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  var STATE_NAMES = {};
  Object.keys(YT_STATES).forEach(function (k) { STATE_NAMES[YT_STATES[k]] = k; });

  var ERRORS = {
    2: 'The video ID is invalid or malformed.',
    5: 'The HTML5 player could not load this video.',
    100: 'Video not found — it may have been removed or made private.',
    101: 'The video owner has disabled embedded playback.',
    103: 'The video owner has disabled embedded playback.',
    115: 'The video owner has disabled embedded playback.',
    150: 'The video owner has disabled embedded playback.'
  };

  var apiPromise = null;
  var player = null;
  var ready = false;
  var pending = null;
  var current = null;
  var lastState = -1;
  var queue = [];
  var queueIndex = -1;
  var autoplayNext = true;
  var listeners = {};

  function emit(evt, payload) {
    (listeners[evt] || []).slice().forEach(function (cb) {
      try {
        cb(payload);
      } catch (err) {
        console.error('[StreamEngine] listener failed', err);
      }
    });
  }

  function on(evt, cb) {
    listeners[evt] = listeners[evt] || [];
    listeners[evt].push(cb);
    return function () { off(evt, cb); };
  }

  function off(evt, cb) {
    listeners[evt] = (listeners[evt] || []).filter(function (x) { return x !== cb; });
  }

  function loadApi() {
    if (apiPromise) return apiPromise;
    apiPromise = new Promise(function (resolve, reject) {
      if (global.YT && global.YT.Player) return resolve(global.YT);
      var previous = global.onYouTubeIframeAPIReady;
      global.onYouTubeIframeAPIReady = function () {
        if (typeof previous === 'function') previous();
        resolve(global.YT);
      };
      var tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      tag.onerror = function () {
        reject(new Error('Could not load the YouTube player API (network blocked?).'));
      };
      document.head.appendChild(tag);
      setTimeout(function () {
        if (!(global.YT && global.YT.Player)) {
          reject(new Error('Timed out loading the YouTube player API.'));
        }
      }, 15000);
    });
    return apiPromise;
  }

  function startVideo(id, meta) {
    current = Object.assign({ id: id }, meta || {});
    emit('error-clear', current);
    if (ready && player && typeof player.loadVideoById === 'function') {
      try {
        player.loadVideoById(id);
      } catch (err) {
        emit('error', { code: -1, message: err.message, video: current });
        return current;
      }
    } else {
      // Player still warming up — remember and play the moment it is ready.
      pending = { id: id, meta: meta };
    }
    emit('video', current);
    return current;
  }

  function handleError(code) {
    emit('error', {
      code: code,
      message: ERRORS[code] || ('YouTube player error ' + code + '.'),
      video: current
    });
  }

  function playQueueIndex(i) {
    queueIndex = i;
    startVideo(queue[i].id, queue[i]);
    emit('queue', { index: queueIndex, total: queue.length });
  }

  function handleEnded() {
    if (!autoplayNext || !queue.length) return;
    if (queueIndex + 1 < queue.length) {
      playQueueIndex(queueIndex + 1);
    } else {
      emit('queue-end', {});
    }
  }
  var engine = {
    version: VERSION,
    states: YT_STATES,

    /** Create the single persistent YouTube iframe player. */
    mount: function (elementId) {
      return loadApi().then(function (YT) {
        return new Promise(function (resolve) {
          player = new YT.Player(elementId, {
            width: '100%',
            height: '100%',
            playerVars: {
              autoplay: 1,
              controls: 1,
              rel: 0,
              modestbranding: 1,
              playsinline: 1,
              enablejsapi: 1,
              origin: global.location.origin
            },
            events: {
              onReady: function () {
                ready = true;
                resolve(engine);
                emit('ready', {});
                if (pending) {
                  var p = pending;
                  pending = null;
                  startVideo(p.id, p.meta);
                }
              },
              onStateChange: function (e) {
                lastState = e.data;
                emit('state', { state: e.data, name: STATE_NAMES[e.data] || 'UNKNOWN', video: current });
                if (e.data === YT_STATES.ENDED) handleEnded();
              },
              onError: function (e) { handleError(e.data); }
            }
          });
        });
      });
    },

    /** Play a video IN THIS TAB (never a new window/tab). */
    play: function (id, meta) { return startVideo(id, meta); },
    pause: function () { if (ready && player) player.pauseVideo(); },
    resume: function () { if (ready && player) player.playVideo(); },
    toggle: function () {
      if (!ready || !player) return;
      if (lastState === YT_STATES.PLAYING) player.pauseVideo();
      else player.playVideo();
    },
    stop: function () {
      if (ready && player) player.stopVideo();
      current = null;
      emit('stopped', {});
    },
    seekBy: function (seconds) {
      if (!ready || !player || typeof player.getCurrentTime !== 'function') return;
      var t = Math.max(0, player.getCurrentTime() + seconds);
      player.seekTo(t, true);
    },
    seekTo: function (seconds) {
      if (!ready || !player || typeof player.seekTo !== 'function') return;
      player.seekTo(Math.max(0, Number(seconds) || 0), true);
    },
    getCurrentTime: function () {
      if (!ready || !player || typeof player.getCurrentTime !== 'function') return 0;
      return Math.max(0, Number(player.getCurrentTime()) || 0);
    },
    setVolume: function (v) { if (ready && player) player.setVolume(v); },
    fullscreen: function () {
      var frame = player && player.getIframe ? player.getIframe() : null;
      if (frame && frame.requestFullscreen) frame.requestFullscreen();
    },

    setQueue: function (videos, startIndex) {
      queue = (videos || []).slice();
      queueIndex = typeof startIndex === 'number' ? startIndex : -1;
      emit('queue', { index: queueIndex, total: queue.length });
    },
    getQueue: function () { return queue.slice(); },
    next: function () { if (queueIndex + 1 < queue.length) playQueueIndex(queueIndex + 1); },
    previous: function () { if (queueIndex > 0) playQueueIndex(queueIndex - 1); },
    setAutoplay: function (on) { autoplayNext = Boolean(on); },
    isAutoplay: function () { return autoplayNext; },

    getCurrent: function () { return current; },
    getState: function () { return lastState; },
    isReady: function () { return ready; },
    on: on,
    off: off
  };

  global.StreamEngine = engine;
})(window);

