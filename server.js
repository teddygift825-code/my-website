/**
 * StreamVault server
 * ------------------
 * Serves the public frontend plus a small JSON API:
 *   GET /api/health               -> service status
 *   GET /api/channels             -> curated channel catalog
 *   GET /api/channels/:id         -> single channel + its videos
 *   GET /api/channels/:id/videos  -> videos for a channel
 *   GET /api/search?q=...         -> YouTube search (API key) or built-in catalog search
 *   GET /api/video/:id            -> video metadata via YouTube oEmbed (no key needed)
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = path.join(ROOT, 'data', 'channels.json');
const USERS_FILE = path.join(ROOT, 'data', 'users.json');
const ACTIVITY_FILE = path.join(ROOT, 'data', 'activity.json');
const COMMUNITY_FILE = path.join(ROOT, 'data', 'community.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');
const LOGIN_FILE = path.join(PUBLIC_DIR, 'login.html');
const ADMIN_FILE = path.join(PUBLIC_DIR, 'admin.html');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
const BAN_GRACE_MS = 20_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const YOUTUBE_FETCH_TIMEOUT_MS = 8_000;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn('[streamvault] could not read ' + file + ': ' + err.message);
    return fallback;
  }
}

const config = readJson(CONFIG_FILE, {});
const API_KEY = process.env.YOUTUBE_API_KEY || config.YOUTUBE_API_KEY || '';
const PORT = Number(process.env.PORT || config.PORT || 3000);

const app = express();
const sessions = new Map();
const searchCursors = new Map();
const resetRequests = new Map();
const communityPostTimes = new Map();
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4, fieldSize: 5 * 1024 } });
const analytics = {
  requests: 0,
  startedAt: new Date().toISOString(),
  hitsByPath: {},
  activeSessions: 0
};

app.disable('x-powered-by');
app.use(express.json());

function getCatalog() {
  return readJson(DATA_FILE, { channels: [] });
}

function readUsers() {
  return readJson(USERS_FILE, { users: [] });
}

function readActivity() {
  return readJson(ACTIVITY_FILE, { history: [] });
}

function readCommunity() {
  return readJson(COMMUNITY_FILE, { chat: [], comments: [], memes: [] });
}

function writeUsers(data) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

function writeActivity(data) {
  fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(data, null, 2));
}

function writeCommunity(data) {
  fs.writeFileSync(COMMUNITY_FILE, JSON.stringify(data, null, 2));
}

function userProfile(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    bio: user.bio || '',
    avatarUrl: user.avatarUrl || '',
    role: user.role
  };
}

function imageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: 'png', mime: 'image/png' };
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return { extension: 'jpg', mime: 'image/jpeg' };
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return { extension: 'gif', mime: 'image/gif' };
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return { extension: 'webp', mime: 'image/webp' };
  return null;
}

function saveImage(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) return null;
  const type = imageType(file.buffer);
  if (!type) return null;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const filename = crypto.randomBytes(18).toString('hex') + '.' + type.extension;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), file.buffer, { flag: 'wx' });
  return '/uploads/' + filename;
}

function requireUserApi(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Sign in to continue.' });
  req.user = user;
  next();
}

function checkCommunityRate(userId, minimumInterval) {
  const now = Date.now();
  const last = communityPostTimes.get(userId) || 0;
  if (now - last < minimumInterval) return false;
  communityPostTimes.set(userId, now);
  return true;
}

function calculateBanExpiry(duration, unit, startsAt) {
  if (unit === 'permanent') return null;
  const amount = Number(duration);
  if (!Number.isInteger(amount) || amount < 1 || amount > 1000) return undefined;
  const start = new Date(startsAt);
  if (!Number.isFinite(start.getTime())) return undefined;
  const fixedDurations = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
  if (fixedDurations[unit]) return new Date(start.getTime() + amount * fixedDurations[unit]).toISOString();
  if (unit !== 'month' && unit !== 'year') return undefined;

  const originalDay = start.getUTCDate();
  const targetMonth = start.getUTCMonth() + (unit === 'month' ? amount : amount * 12);
  start.setUTCDate(1);
  start.setUTCMonth(targetMonth);
  const finalDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  start.setUTCDate(Math.min(originalDay, finalDay));
  return start.toISOString();
}

function describeBan(user) {
  if (!user || !user.banned) return '';
  const expiresAt = Date.parse(user.banExpiresAt || '');
  if (!Number.isFinite(expiresAt)) {
    return 'Your account has received a permanent ban. Contact an administrator for more information.';
  }
  const duration = Number(user.banDuration);
  const unit = String(user.banUnit || 'day');
  const unitLabel = duration === 1 ? unit : unit + 's';
  return 'Your account has received a temporary ban for ' + duration + ' ' + unitLabel + '.';
}

function clearExpiredBan(userId, bannedAt, banExpiresAt) {
  const data = readUsers();
  const users = Array.isArray(data.users) ? data.users : [];
  const user = users.find(item => item.id === userId);
  if (!user || !user.banned || user.bannedAt !== bannedAt || user.banExpiresAt !== banExpiresAt) return null;
  user.banned = false;
  user.status = 'active';
  delete user.bannedAt;
  delete user.banExpiresAt;
  writeUsers({ users });
  return user;
}

function scheduleBanExpiry(userId, bannedAt, banExpiresAt) {
  const expiresAt = Date.parse(banExpiresAt || '');
  if (!Number.isFinite(expiresAt)) return;
  const scheduleNextCheck = () => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      clearExpiredBan(userId, bannedAt, banExpiresAt);
      return;
    }
    const timer = setTimeout(scheduleNextCheck, Math.min(remaining, MAX_TIMEOUT_MS));
    if (timer.unref) timer.unref();
  };
  scheduleNextCheck();
}

function restoreBanExpirations() {
  const data = readUsers();
  const users = Array.isArray(data.users) ? data.users : [];
  users.forEach(user => {
    if (user.banned && user.banExpiresAt) scheduleBanExpiry(user.id, user.bannedAt, user.banExpiresAt);
  });
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password || '')).digest('hex');
}

function createMailTransporter() {
  const host = process.env.SMTP_HOST || config.SMTP_HOST;
  const user = process.env.SMTP_USER || config.SMTP_USER;
  const pass = process.env.SMTP_PASS || config.SMTP_PASS;
  if (!host || !user || !pass) return null;
  const port = Number(process.env.SMTP_PORT || config.SMTP_PORT || 587);
  const secureValue = process.env.SMTP_SECURE || config.SMTP_SECURE;
  return nodemailer.createTransport({
    host,
    port,
    secure: secureValue === undefined ? port === 465 : String(secureValue).toLowerCase() === 'true',
    auth: { user, pass }
  });
}

function saveSearchCursor(cursor) {
  if (!cursor) return null;
  const now = Date.now();
  searchCursors.forEach((value, key) => {
    if (value.expiresAt <= now) searchCursors.delete(key);
  });
  while (searchCursors.size >= 500) searchCursors.delete(searchCursors.keys().next().value);
  const id = crypto.randomBytes(18).toString('hex');
  searchCursors.set(id, Object.assign({ expiresAt: now + 10 * 60 * 1000 }, cursor));
  return id;
}

function takeSearchCursor(id) {
  const cursor = searchCursors.get(id);
  if (!cursor || cursor.expiresAt <= Date.now()) {
    searchCursors.delete(id);
    return null;
  }
  return cursor;
}

function findContinuation(data) {
  let token = '';
  const visit = node => {
    if (!node || typeof node !== 'object' || token) return;
    if (node.continuationCommand && node.continuationCommand.token) {
      token = node.continuationCommand.token;
      return;
    }
    if (node.nextContinuationData && node.nextContinuationData.continuation) {
      token = node.nextContinuationData.continuation;
      return;
    }
    Object.keys(node).forEach(key => visit(node[key]));
  };
  visit(data);
  return token;
}

function videosFromYoutubeData(data) {
  const found = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.videoRenderer) found.push(node.videoRenderer);
    Object.keys(node).forEach(key => visit(node[key]));
  };
  visit(data);
  return Array.from(new Map(found
    .filter(video => video && video.videoId)
    .map(video => [video.videoId, {
      id: video.videoId,
      title: decodeEntities(extractText(video.title)),
      channel: decodeEntities(extractText(video.longBylineText || video.ownerText)),
      live: Boolean(video.badges && video.badges.some(badge => String(badge.label || '').toLowerCase().includes('live'))),
      thumbnail: bestThumbnailUrl(video.thumbnail) || thumbFor(video.videoId),
      channelId: (video.longBylineText && video.longBylineText.runs && video.longBylineText.runs[0] && video.longBylineText.runs[0].navigationEndpoint && video.longBylineText.runs[0].navigationEndpoint.browseEndpoint && video.longBylineText.runs[0].navigationEndpoint.browseEndpoint.browseId) || ''
    }])).values());
}

function sanitizeUser(user) {
  if (!user) return null;
  const out = { ...user };
  delete out.passwordHash;
  delete out.sessionToken;
  delete out.passwordResetTokenHash;
  delete out.passwordResetExpiresAt;
  return out;
}

function ensureDefaultAdmin() {
  const data = readUsers();
  const users = Array.isArray(data.users) ? data.users : [];
  if (!users.some(u => u.role === 'admin')) {
    const adminUser = {
      id: 'admin-1',
      username: 'admin',
      email: 'admin@streamvault.local',
      passwordHash: hashPassword('Admin123!'),
      role: 'admin',
      banned: false,
      status: 'active',
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
      sessionToken: null
    };
    users.push(adminUser);
    writeUsers({ users });
    console.log('[streamvault] default admin created: username=admin password=Admin123!');
  }
}

function resolveUserByToken(token) {
  if (!token) return null;
  const data = readUsers();
  const users = Array.isArray(data.users) ? data.users : [];
  return users.find(u => u.sessionToken === token) || null;
}

function getSessionUser(req) {
  const cookie = String(req.headers.cookie || '');
  const match = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('streamvault_session='));
  const token = match ? decodeURIComponent(match.split('=').slice(1).join('=')) : '';
  const user = resolveUserByToken(token);
  if (!user) return null;
  if (user.banned) {
    const banExpiresAt = Date.parse(user.banExpiresAt || '');
    if (Number.isFinite(banExpiresAt) && Date.now() >= banExpiresAt) {
      return clearExpiredBan(user.id, user.bannedAt, user.banExpiresAt);
    }
    const bannedAt = Date.parse(user.bannedAt || '');
    if (!Number.isFinite(bannedAt) || Date.now() >= bannedAt + BAN_GRACE_MS) {
      const data = readUsers();
      const users = Array.isArray(data.users) ? data.users : [];
      const currentUser = users.find(item => item.id === user.id);
      if (currentUser && currentUser.sessionToken === token) {
        currentUser.sessionToken = null;
        writeUsers({ users });
      }
      sessions.delete(token);
      analytics.activeSessions = sessions.size;
      return null;
    }
  }
  return user;
}

function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.redirect('/login');
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  const user = getSessionUser(req);
  const isApiRequest = req.path.startsWith('/api/');
  if (!user) {
    return isApiRequest
      ? res.status(401).json({ ok: false, error: 'Sign in to continue.' })
      : res.redirect('/login');
  }
  if (user.role !== 'admin') {
    return isApiRequest
      ? res.status(403).json({ ok: false, error: 'Administrator access required.' })
      : res.status(403).send('Administrator access required. Sign out and sign in with an administrator account.');
  }
  req.user = user;
  next();
}

function recordRequest(path) {
  analytics.requests += 1;
  analytics.hitsByPath[path] = (analytics.hitsByPath[path] || 0) + 1;
}

function thumbFor(id) {
  return 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg';
}

function withChannelInfo(ch, v) {
  return Object.assign({ channelId: ch.id, channel: ch.name, category: ch.category }, v);
}

function allVideos(catalog) {
  const out = [];
  (catalog.channels || []).forEach(ch => {
    (ch.videos || []).forEach(v => out.push(withChannelInfo(ch, v)));
  });
  return out;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/* ---------- Search engines ---------- */
function extractText(item) {
  if (!item) return '';
  if (typeof item === 'string') return decodeEntities(item);
  if (Array.isArray(item)) return item.map(extractText).join('');
  if (item.runs) return item.runs.map(r => extractText(r.text)).join('');
  if (item.simpleText) return decodeEntities(item.simpleText);
  return '';
}

function bestThumbnailUrl(thumbnail) {
  if (!thumbnail) return '';
  const items = thumbnail.thumbnails || [];
  if (!items.length) return '';
  let best = items[0];
  items.forEach(it => {
    const score = (it.width || 0) * (it.height || 0);
    const bestScore = (best.width || 0) * (best.height || 0);
    if (score > bestScore) best = it;
  });
  return best.url || '';
}

async function youtubeSearchFallback(q) {
  const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
    },
    signal: AbortSignal.timeout(YOUTUBE_FETCH_TIMEOUT_MS)
  });
  const html = await res.text();
  if (!res.ok) {
    throw new Error('YouTube HTML search failed: HTTP ' + res.status);
  }

  const match = html.match(/ytInitialData\s*=\s*(\{.*?\});\s*<\/script>/s);
  if (!match) {
    throw new Error('YouTube search page did not expose result data.');
  }

  const data = JSON.parse(match[1]);
  const apiKey = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1] || '';
  const contextMatch = html.match(/"INNERTUBE_CONTEXT":(\{.*?\}),"INNERTUBE_CONTEXT_CLIENT_NAME"/s);
  let context = null;
  if (contextMatch) {
    try { context = JSON.parse(contextMatch[1]); } catch (err) { context = null; }
  }
  return {
    videos: videosFromYoutubeData(data),
    continuation: findContinuation(data),
    apiKey,
    context
  };
}

async function youtubeContinueFallback(cursor) {
  if (!cursor.apiKey || !cursor.context || !cursor.continuation) return { videos: [], continuation: '' };
  const clientVersion = cursor.context.client && cursor.context.client.clientVersion || '';
  const res = await fetch('https://www.youtube.com/youtubei/v1/search?key=' + encodeURIComponent(cursor.apiKey), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'X-YouTube-Client-Name': '1',
      'X-YouTube-Client-Version': clientVersion
    },
    body: JSON.stringify({ context: cursor.context, continuation: cursor.continuation }),
    signal: AbortSignal.timeout(YOUTUBE_FETCH_TIMEOUT_MS)
  });
  const data = await res.json();
  if (!res.ok) throw new Error('YouTube continuation failed: HTTP ' + res.status);
  return { videos: videosFromYoutubeData(data), continuation: findContinuation(data) };
}

async function youtubeSearch(q, channelId, pageToken) {
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    maxResults: '50',
    key: API_KEY
  });
  if (q) params.set('q', q);
  if (channelId) params.set('channelId', channelId);
  if (pageToken) params.set('pageToken', pageToken);

  const url = 'https://www.googleapis.com/youtube/v3/search?' + params.toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(YOUTUBE_FETCH_TIMEOUT_MS) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body.error && body.error.message) || ('YouTube API HTTP ' + res.status));
  }
  const videos = (body.items || [])
    .filter(it => it.id && it.id.videoId)
    .map(it => ({
      id: it.id.videoId,
      title: decodeEntities(it.snippet.title),
      channel: decodeEntities(it.snippet.channelTitle),
      channelId: it.snippet.channelId,
      live: it.snippet.liveBroadcastContent === 'live',
      thumbnail: (it.snippet.thumbnails &&
        it.snippet.thumbnails.medium &&
        it.snippet.thumbnails.medium.url) || thumbFor(it.id.videoId)
    }));
  return { videos, nextPageToken: body.nextPageToken || '' };
}
/* ---------- Auth + Admin routes ---------- */
app.get('/api/auth/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  const banExpiresAt = user.banned ? Date.parse(user.bannedAt) + BAN_GRACE_MS : null;
  return res.json({ ok: true, user: sanitizeUser(user), banExpiresAt, banNotice: describeBan(user) });
});

app.post('/api/auth/password-reset/request', async (req, res) => {
  const transporter = createMailTransporter();
  if (!transporter) {
    return res.status(503).json({ ok: false, error: 'Password reset email is not configured. Contact the site administrator.' });
  }

  const now = Date.now();
  resetRequests.forEach((expiresAt, key) => {
    if (expiresAt <= now) resetRequests.delete(key);
  });
  const requestKey = req.ip || req.socket.remoteAddress || 'unknown';
  if (resetRequests.has(requestKey)) {
    return res.json({ ok: true, message: 'If an account uses that email, a reset link will be sent.' });
  }
  resetRequests.set(requestKey, now + 60_000);

  const email = String(req.body && req.body.email || '').trim().toLowerCase();
  const data = readUsers();
  const users = Array.isArray(data.users) ? data.users : [];
  const user = users.find(item => String(item.email || '').trim().toLowerCase() === email);
  if (!user || !email) {
    return res.json({ ok: true, message: 'If an account uses that email, a reset link will be sent.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  user.passwordResetTokenHash = tokenHash;
  user.passwordResetExpiresAt = new Date(now + 15 * 60_000).toISOString();
  writeUsers({ users });

  const baseUrl = process.env.PUBLIC_BASE_URL || config.PUBLIC_BASE_URL || (req.protocol + '://' + req.get('host'));
  const resetUrl = new URL('/reset-password?token=' + encodeURIComponent(token), baseUrl).toString();
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || config.SMTP_FROM || process.env.SMTP_USER || config.SMTP_USER,
      to: user.email,
      subject: 'Reset your Freedom Journey password',
      text: 'Use this link within 15 minutes to choose a new Freedom Journey password: ' + resetUrl,
      html: '<p>Use this link within 15 minutes to choose a new Freedom Journey password:</p><p><a href="' + resetUrl + '">Reset password</a></p>'
    });
  } catch (err) {
    if (user.passwordResetTokenHash === tokenHash) {
      delete user.passwordResetTokenHash;
      delete user.passwordResetExpiresAt;
      writeUsers({ users });
    }
    console.error('[streamvault] password reset email failed: ' + err.message);
    return res.status(503).json({ ok: false, error: 'Could not send the reset email. Try again later.' });
  }
  return res.json({ ok: true, message: 'If an account uses that email, a reset link will be sent.' });
});

app.post('/api/auth/password-reset/complete', (req, res) => {
  const token = String(req.body && req.body.token || '');
  const newPassword = String(req.body && req.body.newPassword || '');
  if (!token || newPassword.length < 6) {
    return res.status(400).json({ ok: false, error: 'A valid reset link and password of at least 6 characters are required.' });
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const data = readUsers();
  const users = Array.isArray(data.users) ? data.users : [];
  const user = users.find(item => item.passwordResetTokenHash === tokenHash);
  const expiresAt = user ? Date.parse(user.passwordResetExpiresAt || '') : NaN;
  if (!user || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return res.status(400).json({ ok: false, error: 'This reset link is invalid or expired. Request a new one.' });
  }

  const oldToken = user.sessionToken;
  user.passwordHash = hashPassword(newPassword);
  user.sessionToken = null;
  delete user.passwordResetTokenHash;
  delete user.passwordResetExpiresAt;
  writeUsers({ users });
  if (oldToken) sessions.delete(oldToken);
  analytics.activeSessions = sessions.size;
  res.setHeader('Set-Cookie', 'streamvault_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  return res.json({ ok: true, message: 'Password updated. Please log in.' });
});

app.post('/api/auth/signup', (req, res) => {
  const username = String(req.body && req.body.username || '').trim();
  const password = String(req.body && req.body.password || '');
  const email = String(req.body && req.body.email || '').trim().toLowerCase();

  if (!username || !password || password.length < 6 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'Username, a valid email, and a password of at least 6 characters are required.' });
  }

  const data = readUsers();
  const users = Array.isArray(data.users) ? data.users : [];
  if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ ok: false, error: 'Username already exists.' });
  }
  if (users.some(u => String(u.email || '').toLowerCase() === email)) {
    return res.status(409).json({ ok: false, error: 'Email already exists.' });
  }

  const newUser = {
    id: 'user-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8),
    username,
    email,
    passwordHash: hashPassword(password),
    role: 'user',
    banned: false,
    status: 'active',
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
    sessionToken: null
  };
  users.push(newUser);
  writeUsers({ users });
  return res.status(201).json({ ok: true, message: 'Account created. Please log in.' });
});

app.post('/api/auth/login', (req, res) => {
  const username = String(req.body && req.body.username || '').trim();
  const password = String(req.body && req.body.password || '');

  const data = readUsers();
  const users = Array.isArray(data.users) ? data.users : [];
  let user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ ok: false, error: 'Invalid username or password.' });
  }
  const banExpiresAt = Date.parse(user.banExpiresAt || '');
  if (user.banned && Number.isFinite(banExpiresAt) && Date.now() >= banExpiresAt) {
    user = clearExpiredBan(user.id, user.bannedAt, user.banExpiresAt) || user;
  }
  if (user.banned) {
    return res.status(403).json({ ok: false, error: describeBan(user), banned: true });
  }

  const token = crypto.randomBytes(32).toString('hex');
  user.sessionToken = token;
  user.lastLoginAt = new Date().toISOString();
  writeUsers({ users });
  sessions.set(token, user.id);
  analytics.activeSessions = sessions.size;

  const redirectUrl = user.role === 'admin' ? '/admin' : '/public/index.html';

  res.setHeader('Set-Cookie', 'streamvault_session=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Lax');
  return res.json({ ok: true, user: sanitizeUser(user), redirect: redirectUrl });
});

app.post('/api/auth/logout', (req, res) => {
  const token = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('streamvault_session='));
  const realToken = token ? decodeURIComponent(token.split('=').slice(1).join('=')) : '';
  if (realToken) {
    const data = readUsers();
    const users = Array.isArray(data.users) ? data.users : [];
    users.forEach(user => {
      if (user.sessionToken === realToken) user.sessionToken = null;
    });
    writeUsers({ users });
    sessions.delete(realToken);
    analytics.activeSessions = sessions.size;
  }
  res.setHeader('Set-Cookie', 'streamvault_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  return res.json({ ok: true });
});

app.get('/api/me/profile', requireUserApi, (req, res) => {
  return res.json({ ok: true, profile: userProfile(req.user), warnings: req.user.warnings || [] });
});

app.patch('/api/me/profile', requireUserApi, (req, res) => {
  const displayName = String(req.body && req.body.displayName || '').trim();
  const bio = String(req.body && req.body.bio || '').trim();
  if (displayName.length > 40 || bio.length > 200) {
    return res.status(400).json({ ok: false, error: 'Display name must be under 40 characters and bio under 200.' });
  }
  const data = readUsers();
  const users = Array.isArray(data.users) ? data.users : [];
  const user = users.find(item => item.id === req.user.id);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found.' });
  user.displayName = displayName || user.username;
  user.bio = bio;
  writeUsers({ users });
  return res.json({ ok: true, profile: userProfile(user), bio: user.bio });
});

app.post('/api/me/profile/avatar', requireUserApi, (req, res, next) => {
  imageUpload.single('image')(req, res, err => {
    if (err) return res.status(400).json({ ok: false, error: 'Choose an image smaller than 5 MB.' });
    next();
  });
}, (req, res) => {
  const avatarUrl = saveImage(req.file);
  if (!avatarUrl) return res.status(400).json({ ok: false, error: 'Use a JPEG, PNG, GIF, or WebP image.' });
  const data = readUsers();
  const users = Array.isArray(data.users) ? data.users : [];
  const user = users.find(item => item.id === req.user.id);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found.' });
  user.avatarUrl = avatarUrl;
  writeUsers({ users });
  return res.json({ ok: true, avatarUrl });
});

app.get('/api/me/history', requireUserApi, (req, res) => {
  const data = readActivity();
  const history = (Array.isArray(data.history) ? data.history : [])
    .filter(item => item.userId === req.user.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return res.json({ ok: true, history });
});

app.post('/api/me/history', requireUserApi, (req, res) => {
  const type = String(req.body && req.body.type || '');
  const value = String(req.body && req.body.value || '').trim().slice(0, 300);
  if (!['watch', 'search'].includes(type) || !value) return res.status(400).json({ ok: false, error: 'Invalid history item.' });
  const data = readActivity();
  const history = Array.isArray(data.history) ? data.history : [];
  const prior = history.findIndex(item => item.userId === req.user.id && item.type === type && item.value === value);
  if (prior !== -1) history.splice(prior, 1);
  history.push({ id: crypto.randomBytes(12).toString('hex'), userId: req.user.id, type, value, title: String(req.body && req.body.title || '').slice(0, 200), createdAt: new Date().toISOString() });
  while (history.length > 5000) history.shift();
  writeActivity({ history });
  return res.json({ ok: true });
});

app.delete('/api/me/history', requireUserApi, (req, res) => {
  const type = String(req.query.type || 'all');
  if (!['all', 'watch', 'search'].includes(type)) return res.status(400).json({ ok: false, error: 'Invalid history type.' });
  const data = readActivity();
  const history = (Array.isArray(data.history) ? data.history : []).filter(item =>
    item.userId !== req.user.id || (type !== 'all' && item.type !== type)
  );
  writeActivity({ history });
  return res.json({ ok: true });
});

app.patch('/api/me/warnings/:id/read', requireUserApi, (req, res) => {
  const data = readUsers();
  const users = Array.isArray(data.users) ? data.users : [];
  const user = users.find(item => item.id === req.user.id);
  const warning = user && (user.warnings || []).find(item => item.id === req.params.id);
  if (!warning) return res.status(404).json({ ok: false, error: 'Warning not found.' });
  warning.readAt = new Date().toISOString();
  writeUsers({ users });
  return res.json({ ok: true });
});

app.get('/api/community/chat', requireUserApi, (req, res) => {
  const data = readCommunity();
  const messages = Array.isArray(data.chat) ? data.chat : [];
  const after = String(req.query.after || '');
  const index = after ? messages.findIndex(item => item.id === after) : -1;
  const result = index >= 0 ? messages.slice(index + 1, index + 101) : messages.slice(-50);
  return res.json({ ok: true, messages: result });
});

app.post('/api/community/chat', requireUserApi, (req, res) => {
  const message = String(req.body && req.body.message || '').trim();
  if (!message || message.length > 500) return res.status(400).json({ ok: false, error: 'Messages must be between 1 and 500 characters.' });
  if (!checkCommunityRate(req.user.id, 800)) return res.status(429).json({ ok: false, error: 'Please wait before sending another message.' });
  const data = readCommunity();
  const chat = Array.isArray(data.chat) ? data.chat : [];
  const item = { id: crypto.randomBytes(12).toString('hex'), message, author: userProfile(req.user), createdAt: new Date().toISOString() };
  chat.push(item);
  while (chat.length > 2000) chat.shift();
  writeCommunity({ ...data, chat });
  return res.status(201).json({ ok: true, message: item });
});

app.get('/api/videos/:id/comments', requireUserApi, (req, res) => {
  const videoId = String(req.params.id || '');
  if (!/^[\w-]{6,20}$/.test(videoId)) return res.status(400).json({ ok: false, error: 'Invalid video id.' });
  const data = readCommunity();
  const comments = (Array.isArray(data.comments) ? data.comments : []).filter(item => item.videoId === videoId).slice(-100);
  return res.json({ ok: true, comments });
});

app.post('/api/videos/:id/comments', requireUserApi, (req, res) => {
  const videoId = String(req.params.id || '');
  const message = String(req.body && req.body.message || '').trim();
  if (!/^[\w-]{6,20}$/.test(videoId)) return res.status(400).json({ ok: false, error: 'Invalid video id.' });
  if (!message || message.length > 1000) return res.status(400).json({ ok: false, error: 'Comments must be between 1 and 1000 characters.' });
  if (!checkCommunityRate(req.user.id, 1000)) return res.status(429).json({ ok: false, error: 'Please wait before commenting again.' });
  const data = readCommunity();
  const comments = Array.isArray(data.comments) ? data.comments : [];
  const item = { id: crypto.randomBytes(12).toString('hex'), videoId, message, author: userProfile(req.user), createdAt: new Date().toISOString() };
  comments.push(item);
  while (comments.length > 10000) comments.shift();
  writeCommunity({ ...data, comments });
  return res.status(201).json({ ok: true, comment: item });
});

app.patch('/api/videos/:id/comments/:commentId', requireUserApi, (req, res) => {
  const videoId = String(req.params.id || '');
  const message = String(req.body && req.body.message || '').trim();
  if (!/^[\w-]{6,20}$/.test(videoId)) return res.status(400).json({ ok: false, error: 'Invalid video id.' });
  if (!message || message.length > 1000) return res.status(400).json({ ok: false, error: 'Comments must be between 1 and 1000 characters.' });
  const data = readCommunity();
  const comments = Array.isArray(data.comments) ? data.comments : [];
  const comment = comments.find(item => item.id === req.params.commentId && item.videoId === videoId);
  if (!comment) return res.status(404).json({ ok: false, error: 'Comment not found.' });
  if (!comment.author || comment.author.id !== req.user.id) {
    return res.status(403).json({ ok: false, error: 'You can edit only your own comments.' });
  }
  comment.message = message;
  comment.updatedAt = new Date().toISOString();
  writeCommunity({ ...data, comments });
  return res.json({ ok: true, comment });
});

app.delete('/api/videos/:id/comments/:commentId', requireUserApi, (req, res) => {
  const videoId = String(req.params.id || '');
  if (!/^[\w-]{6,20}$/.test(videoId)) return res.status(400).json({ ok: false, error: 'Invalid video id.' });
  const data = readCommunity();
  const comments = Array.isArray(data.comments) ? data.comments : [];
  const comment = comments.find(item => item.id === req.params.commentId && item.videoId === videoId);
  if (!comment) return res.status(404).json({ ok: false, error: 'Comment not found.' });
  if (!comment.author || comment.author.id !== req.user.id) {
    return res.status(403).json({ ok: false, error: 'You can delete only your own comments.' });
  }
  writeCommunity({ ...data, comments: comments.filter(item => item.id !== comment.id) });
  return res.json({ ok: true });
});

app.get('/api/community/memes', requireUserApi, (req, res) => {
  const data = readCommunity();
  return res.json({ ok: true, memes: (Array.isArray(data.memes) ? data.memes : []).slice(-100).reverse() });
});

app.post('/api/community/memes', requireUserApi, (req, res, next) => {
  imageUpload.single('image')(req, res, err => {
    if (err) return res.status(400).json({ ok: false, error: 'Choose an image smaller than 5 MB.' });
    next();
  });
}, (req, res) => {
  if (!checkCommunityRate(req.user.id, 10_000)) return res.status(429).json({ ok: false, error: 'Please wait before posting another meme.' });
  const imageUrl = saveImage(req.file);
  if (!imageUrl) return res.status(400).json({ ok: false, error: 'Upload a JPEG, PNG, GIF, or WebP image.' });
  const data = readCommunity();
  const memes = Array.isArray(data.memes) ? data.memes : [];
  const item = { id: crypto.randomBytes(12).toString('hex'), imageUrl, caption: String(req.body && req.body.caption || '').trim().slice(0, 300), author: userProfile(req.user), createdAt: new Date().toISOString() };
  memes.push(item);
  while (memes.length > 1000) memes.shift();
  writeCommunity({ ...data, memes });
  return res.status(201).json({ ok: true, meme: item });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const data = readUsers();
  const users = Array.isArray(data.users) ? data.users : [];
  return res.json({
    ok: true,
    users: users.map(u => sanitizeUser(u))
  });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const data = readUsers();
  const users = Array.isArray(data.users) ? data.users : [];
  const now = new Date();
  const totalUsers = users.length;
  const activeUsers = users.filter(u => !u.banned).length;
  const bannedUsers = users.filter(u => u.banned).length;
  const admins = users.filter(u => u.role === 'admin').length;
  const today = users.filter(u => u.createdAt && new Date(u.createdAt).toDateString() === now.toDateString()).length;

  return res.json({
    ok: true,
    stats: {
      totalUsers,
      activeUsers,
      bannedUsers,
      admins,
      newToday: today,
      requests: analytics.requests,
      startedAt: analytics.startedAt,
      activeSessions: sessions.size,
      hitsByPath: analytics.hitsByPath
    }
  });
});

app.patch('/api/admin/users/:id/ban', requireAdmin, (req, res) => {
  const data = readUsers();
  const users = Array.isArray(data.users) ? data.users : [];
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found.' });
  if (user.role === 'admin' && user.id !== req.user.id) {
    return res.status(403).json({ ok: false, error: 'You cannot ban another admin.' });
  }
  const shouldBan = Boolean(req.body && req.body.banned !== undefined ? req.body.banned : !user.banned);
  const bannedAt = shouldBan ? new Date().toISOString() : null;
  const banUnit = String(req.body && req.body.unit || 'permanent');
  const banExpiresAt = shouldBan ? calculateBanExpiry(req.body && req.body.duration, banUnit, bannedAt) : null;
  if (shouldBan && banExpiresAt === undefined) {
    return res.status(400).json({ ok: false, error: 'Choose a valid ban duration and unit.' });
  }
  const oldToken = user.sessionToken;
  user.banned = shouldBan;
  user.status = user.banned ? 'banned' : 'active';
  if (user.banned) {
    user.bannedAt = bannedAt;
    user.banUnit = banUnit;
    if (banUnit !== 'permanent') user.banDuration = Number(req.body.duration);
    else delete user.banDuration;
    if (banExpiresAt) user.banExpiresAt = banExpiresAt;
    else delete user.banExpiresAt;
  } else {
    delete user.bannedAt;
    delete user.banExpiresAt;
    delete user.banUnit;
    delete user.banDuration;
  }
  writeUsers({ users });
  if (shouldBan && banExpiresAt) scheduleBanExpiry(user.id, bannedAt, banExpiresAt);
  if (shouldBan && oldToken) {
    const userId = user.id;
    const timer = setTimeout(() => {
      const currentData = readUsers();
      const currentUsers = Array.isArray(currentData.users) ? currentData.users : [];
      const currentUser = currentUsers.find(item => item.id === userId);
      if (currentUser && currentUser.banned && currentUser.bannedAt === bannedAt && currentUser.sessionToken === oldToken) {
        currentUser.sessionToken = null;
        writeUsers({ users: currentUsers });
        sessions.delete(oldToken);
        analytics.activeSessions = sessions.size;
      }
    }, BAN_GRACE_MS);
    if (timer.unref) timer.unref();
  }
  analytics.activeSessions = sessions.size;
  return res.json({ ok: true, user: sanitizeUser(user) });
});

app.patch('/api/admin/users/:id/reset-password', requireAdmin, (req, res) => {
  const data = readUsers();
  const users = Array.isArray(data.users) ? data.users : [];
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found.' });
  const newPassword = String(req.body && req.body.newPassword || '');
  if (newPassword.length < 6) {
    return res.status(400).json({ ok: false, error: 'New password must be at least 6 characters.' });
  }
  const oldToken = user.sessionToken;
  user.passwordHash = hashPassword(newPassword);
  user.sessionToken = null;
  writeUsers({ users });
  if (oldToken) sessions.delete(oldToken);
  analytics.activeSessions = sessions.size;
  return res.json({ ok: true, message: 'Password reset. User must log in again.' });
});

app.post('/api/admin/users/:id/warnings', requireAdmin, (req, res) => {
  const message = String(req.body && req.body.message || '').trim();
  if (!message || message.length > 500) {
    return res.status(400).json({ ok: false, error: 'Warning must be between 1 and 500 characters.' });
  }
  const data = readUsers();
  const users = Array.isArray(data.users) ? data.users : [];
  const user = users.find(item => item.id === req.params.id);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found.' });
  user.warnings = Array.isArray(user.warnings) ? user.warnings : [];
  const warning = {
    id: crypto.randomBytes(12).toString('hex'),
    message,
    createdAt: new Date().toISOString(),
    readAt: null,
    sentBy: req.user.username
  };
  user.warnings.push(warning);
  writeUsers({ users });
  return res.status(201).json({ ok: true, warning });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasApiKey: Boolean(API_KEY), emailVerificationConfigured: Boolean(createMailTransporter()), now: new Date().toISOString() });
});

app.get('/api/channels', (req, res) => {
  res.json(getCatalog());
});

app.get('/api/channels/:id', (req, res) => {
  const cat = getCatalog();
  const ch = (cat.channels || []).find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  res.json({ channel: ch, videos: (ch.videos || []).map(v => withChannelInfo(ch, v)) });
});

app.get('/api/channels/:id/videos', async (req, res) => {
  const cat = getCatalog();
  const ch = (cat.channels || []).find(c => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });

  // Remote fetch is only attempted when the catalog provides a real
  // YouTube channel id AND an API key is configured.
  if (API_KEY && ch.youtubeChannelId) {
    try {
      const result = await youtubeSearch('', ch.youtubeChannelId);
      if (result.videos.length) return res.json({ channel: ch, videos: result.videos, source: 'youtube' });
    } catch (err) {
      console.warn('[streamvault] remote channel fetch failed: ' + err.message);
    }
  }

  res.json({
    channel: ch,
    videos: (ch.videos || []).map(v => withChannelInfo(ch, v)),
    source: 'catalog'
  });
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const cat = getCatalog();

  if (req.query.cursor) {
    const cursor = takeSearchCursor(String(req.query.cursor));
    if (!cursor) return res.status(400).json({ error: 'Search cursor expired. Start a new search.' });
    try {
      if (cursor.type === 'api') {
        const result = await youtubeSearch(cursor.query, '', cursor.pageToken);
        searchCursors.delete(String(req.query.cursor));
        const nextCursor = result.nextPageToken
          ? saveSearchCursor({ type: 'api', query: cursor.query, pageToken: result.nextPageToken })
          : null;
        return res.json({ source: 'youtube', videos: result.videos, nextCursor });
      }
      const result = await youtubeContinueFallback(cursor);
      searchCursors.delete(String(req.query.cursor));
      const nextCursor = result.continuation
        ? saveSearchCursor(Object.assign({}, cursor, { continuation: result.continuation }))
        : null;
      return res.json({ source: 'youtube', videos: result.videos, nextCursor, fallback: true });
    } catch (err) {
      console.warn('[streamvault] YouTube continuation failed: ' + err.message);
      return res.status(502).json({ error: 'Could not load more YouTube results.' });
    }
  }

  if (!q) {
    return res.json({ source: 'catalog', videos: allVideos(cat), channels: cat.channels || [] });
  }

  if (API_KEY) {
    try {
      const result = await youtubeSearch(q);
      const nextCursor = result.nextPageToken
        ? saveSearchCursor({ type: 'api', query: q, pageToken: result.nextPageToken })
        : null;
      return res.json({ source: 'youtube', videos: result.videos, nextCursor });
    } catch (err) {
      console.warn('[streamvault] YouTube API search failed, retrying HTML fallback: ' + err.message);
    }
  }

  try {
    const result = await youtubeSearchFallback(q);
    if (result.videos.length) {
      const nextCursor = result.continuation && result.apiKey && result.context
        ? saveSearchCursor({
          type: 'html',
          apiKey: result.apiKey,
          context: result.context,
          continuation: result.continuation
        })
        : null;
      return res.json({ source: 'youtube', videos: result.videos, nextCursor, fallback: true });
    }
  } catch (err) {
    console.warn('[streamvault] YouTube HTML fallback failed, using catalog: ' + err.message);
  }

  const needle = q.toLowerCase();
  const videos = allVideos(cat).filter(v =>
    String(v.title || '').toLowerCase().includes(needle) ||
    String(v.channel || '').toLowerCase().includes(needle) ||
    String(v.category || '').toLowerCase().includes(needle)
  );
  res.json({ source: 'catalog', videos, nextCursor: null, fallback: true });
});

app.get('/api/video/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[\w-]{6,20}$/.test(id)) return res.status(400).json({ error: 'Invalid video id' });
  try {
    const target = encodeURIComponent('https://www.youtube.com/watch?v=' + id);
    const r = await fetch('https://www.youtube.com/oembed?format=json&url=' + target);
    if (!r.ok) return res.json({ id, found: false });
    const b = await r.json();
    res.json({ id, found: true, title: b.title, channel: b.author_name, thumbnail: b.thumbnail_url });
  } catch (err) {
    res.json({ id, found: false, error: err.message });
  }
});

/* ---------- Auth gate + static files ---------- */
app.get('/', (req, res) => {
  const user = getSessionUser(req);
  if (user && user.role === 'admin') return res.redirect('/admin');
  if (user) return res.redirect('/public/index.html');
  return res.redirect('/login');
});

app.get('/login', (req, res) => {
  const user = getSessionUser(req);
  if (user && user.role === 'admin') return res.redirect('/admin');
  if (user) return res.redirect('/public/index.html');
  return res.sendFile(LOGIN_FILE);
});

app.get('/reset-password', (req, res) => {
  return res.sendFile(LOGIN_FILE);
});

app.get('/admin', requireAdmin, (req, res) => {
  return res.sendFile(ADMIN_FILE);
});

app.get(['/admin.html', '/public/admin.html'], requireAdmin, (req, res) => {
  return res.redirect('/admin');
});

app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/login.html') return next();
  if (req.path === '/admin' || req.path === '/admin.html') {
    const user = getSessionUser(req);
    if (!user) return res.redirect('/login');
    if (user.role !== 'admin') return res.status(403).send('Administrator access required. Sign out and sign in with an administrator account.');
    return next();
  }
  if (req.path.startsWith('/css/') || req.path.startsWith('/js/') || req.path.startsWith('/api/')) {
    return next();
  }
  if (req.path === '/' || req.path === '/index.html' || req.path === '/public/index.html' || req.path === '/public') {
    const user = getSessionUser(req);
    if (!user) return res.redirect('/login');
  }
  return next();
});

app.use(express.static(PUBLIC_DIR));

app.use((req, res) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html' || req.path === '/public/index.html')) {
    const user = getSessionUser(req);
    if (!user) return res.redirect('/login');
    return res.sendFile(INDEX_FILE);
  }
  return res.status(404).json({ error: 'Not found' });
});

ensureDefaultAdmin();
restoreBanExpirations();
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(ACTIVITY_FILE)) writeActivity({ history: [] });
if (!fs.existsSync(COMMUNITY_FILE)) writeCommunity({ chat: [], comments: [], memes: [] });
app.listen(PORT, () => {
  console.log('Freedom Journey running at http://localhost:' + PORT);
  console.log(API_KEY
    ? 'YouTube Data API key detected — live YouTube search enabled.'
    : 'No YouTube API key — search uses the built-in catalog.');
});

