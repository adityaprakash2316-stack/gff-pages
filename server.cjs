'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v2: cloudinary } = require('cloudinary');

const PORT = Number(process.env.PORT) || 3000;
const PASSWORD = process.env.ADMIN_PASSWORD;
const PUB = path.join(__dirname, 'public');
const MAX = 15 * 1024 * 1024;
const FOLDER = 'gf-pages';
// Set DATA_DIR to a mounted persistent disk (e.g. /var/data on Render) for messages to survive deploys.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MESSAGES_FILE = path.join(DATA_DIR, 'confessions.json');
const MAX_MESSAGE_LENGTH = 2000;
const messageAttempts = new Map();
fs.mkdirSync(DATA_DIR, { recursive: true });
function readMessages() {
  try { const value = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8')); return Array.isArray(value) ? value : []; }
  catch (error) { if (error.code !== 'ENOENT') console.error('Could not read confession inbox:', error.message); return []; }
}
function writeMessages(messages) {
  const temp = MESSAGES_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(messages, null, 2), { mode: 0o600 });
  fs.renameSync(temp, MESSAGES_FILE);
}

if (!PASSWORD || PASSWORD.length < 12) {
  console.error('Set ADMIN_PASSWORD in your environment (at least 12 characters).');
  process.exit(1);
}
if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.error('Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.');
  process.exit(1);
}
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

const sessions = new Set();
const fails = new Map();
const send = (res, code, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(code, {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(body);
};
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim()).filter(Boolean).map(v => {
  const i = v.indexOf('='); return i < 0 ? [v, ''] : [v.slice(0, i), decodeURIComponent(v.slice(i + 1))];
}));
const authed = req => sessions.has(cookie(req).sid);
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const sameHash = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = []; let size = 0; let settled = false;
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) { settled = true; reject(new Error('too big')); req.resume(); return; }
      parts.push(chunk);
    });
    req.on('end', () => { if (!settled) resolve(Buffer.concat(parts)); });
    req.on('error', err => { if (!settled) reject(err); });
  });
}
function sniff(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'png';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (buffer.subarray(0, 3).toString() === 'GIF') return 'gif';
  if (buffer.subarray(4, 8).toString() === 'ftyp') return 'heic';
  return null;
}
function uploadBuffer(buffer, kind, ext) {
  return new Promise((resolve, reject) => {
    const publicId = `${Date.now()}-${kind}-${crypto.randomBytes(6).toString('hex')}`;
    const stream = cloudinary.uploader.upload_stream({
      folder: FOLDER,
      public_id: publicId,
      resource_type: 'image',
      tags: [kind, 'gf-pages']
    }, (error, result) => error ? reject(error) : resolve(result));
    stream.end(buffer);
  });
}
function validPublicId(value) {
  return typeof value === 'string' && /^gf-pages\/\d+-(cute|kiss)-[0-9a-f]{12}$/.test(value);
}
function cloudinaryUploadUrl(result) { return result.secure_url; }

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(PUB, 'index.html')), 'text/html; charset=utf-8');
    }

    if (req.method === 'POST' && url.pathname === '/upload') {
      const kind = url.searchParams.get('kind') === 'kiss' ? 'kiss' : 'cute';
      let body;
      try { body = await readBody(req, MAX); }
      catch (e) { return send(res, e.message === 'too big' ? 413 : 400, 'upload too large or invalid'); }
      const ext = sniff(body);
      if (!ext) return send(res, 400, 'not an image');
      try {
        const result = await uploadBuffer(body, kind, ext);
        console.log('New photo uploaded to Cloudinary:', result.public_id);
        return send(res, 200, 'ok');
      } catch (e) {
        console.error('Cloudinary upload failed:', e.message);
        return send(res, 502, 'photo storage failed');
      }
    }

    // Receive a confession and store it for the admin inbox.
    if (req.method === 'POST' && url.pathname === '/confess') {
      const ip = clientIp(req);
      const attempts = messageAttempts.get(ip) || { count: 0, since: Date.now() };
      if (Date.now() - attempts.since > 10 * 60 * 1000) { attempts.count = 0; attempts.since = Date.now(); }
      if (attempts.count >= 8) return send(res, 429, JSON.stringify({ error: 'Too many messages. Please wait a little before trying again.' }), 'application/json; charset=utf-8');
      let payload;
      try { payload = JSON.parse((await readBody(req, 5000)).toString('utf8')); }
      catch { return send(res, 400, JSON.stringify({ error: 'Please check your message and try again.' }), 'application/json; charset=utf-8'); }
      const name = String(payload.name || '').trim().slice(0, 50);
      const message = String(payload.message || '').trim();
      if (!message) return send(res, 400, JSON.stringify({ error: 'Please write a message first.' }), 'application/json; charset=utf-8');
      if (message.length > MAX_MESSAGE_LENGTH) return send(res, 413, JSON.stringify({ error: 'Message is too long. Please keep it under 2000 characters.' }), 'application/json; charset=utf-8');
      try {
        const messages = readMessages();
        messages.unshift({ id: crypto.randomBytes(12).toString('hex'), name, message, time: Date.now() });
        writeMessages(messages.slice(0, 1000));
        attempts.count++;
        messageAttempts.set(ip, attempts);
        return send(res, 201, JSON.stringify({ ok: true }), 'application/json; charset=utf-8');
      } catch (error) {
        console.error('Could not save confession:', error.message);
        return send(res, 500, JSON.stringify({ error: 'Message storage is unavailable right now. Please try again later.' }), 'application/json; charset=utf-8');
      }
    }

    if (req.method === 'GET' && url.pathname === '/admin') {
      return send(res, 200, fs.readFileSync(path.join(PUB, 'admin.html')), 'text/html; charset=utf-8');
    }

    if (req.method === 'POST' && url.pathname === '/admin/login') {
      const key = clientIp(req);
      const f = fails.get(key) || { n: 0, until: 0 };
      if (f.until > Date.now()) return send(res, 429, 'locked');
      let password = '';
      try { password = JSON.parse((await readBody(req, 2000)).toString()).password || ''; } catch {}
      if (!sameHash(password, PASSWORD)) {
        f.n++;
        if (f.n >= 5) { f.until = Date.now() + 10 * 60 * 1000; f.n = 0; }
        fails.set(key, f);
        return send(res, 401, 'no');
      }
      fails.delete(key);
      const sid = crypto.randomBytes(32).toString('hex');
      sessions.add(sid);
      const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secure}`);
      return send(res, 200, 'ok');
    }

    if (req.method === 'POST' && url.pathname === '/admin/logout') {
      sessions.delete(cookie(req).sid);
      res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' + (process.env.NODE_ENV === 'production' ? '; Secure' : ''));
      return send(res, 200, 'ok');
    }

    if (url.pathname.startsWith('/admin/')) {
      if (!authed(req)) return send(res, 401, 'login required');

      if (req.method === 'GET' && url.pathname === '/admin/messages') {
        return send(res, 200, JSON.stringify(readMessages()), 'application/json; charset=utf-8');
      }

      if (req.method === 'POST' && url.pathname === '/admin/message/delete') {
        let id = '';
        try { id = new URLSearchParams((await readBody(req, 2000)).toString()).get('id') || ''; } catch {}
        if (!/^[0-9a-f]{24}$/.test(id)) return send(res, 400, 'invalid message');
        const messages = readMessages();
        const next = messages.filter(item => item.id !== id);
        if (next.length === messages.length) return send(res, 404, 'message not found');
        try { writeMessages(next); return send(res, 200, 'ok'); }
        catch (error) { console.error('Could not delete confession:', error.message); return send(res, 500, 'delete failed'); }
      }

      if (req.method === 'GET' && url.pathname === '/admin/list') {
        const result = await cloudinary.api.resources({ type: 'upload', prefix: `${FOLDER}/`, max_results: 500, resource_type: 'image' });
        const files = (result.resources || []).filter(item => validPublicId(item.public_id)).map(item => {
          const match = item.public_id.match(/^gf-pages\/(\d+)-(cute|kiss)-[0-9a-f]{12}$/);
          return { name: item.public_id, url: item.secure_url, kind: match[2], time: Number(match[1]) };
        }).sort((a, b) => b.time - a.time);
        return send(res, 200, JSON.stringify(files), 'application/json; charset=utf-8');
      }

      if (req.method === 'GET' && url.pathname.startsWith('/admin/img/')) {
        const publicId = decodeURIComponent(url.pathname.slice('/admin/img/'.length));
        if (!validPublicId(publicId)) return send(res, 404, 'nope');
        const result = await cloudinary.api.resource(publicId, { resource_type: 'image' });
        res.writeHead(302, { Location: result.secure_url, 'Cache-Control': 'no-store' });
        return res.end();
      }

      if (req.method === 'POST' && url.pathname === '/admin/delete') {
        let name = '';
        try { name = new URLSearchParams((await readBody(req, 2000)).toString()).get('name') || ''; } catch {}
        if (!validPublicId(name)) return send(res, 400, 'invalid photo');
        const result = await cloudinary.uploader.destroy(name, { resource_type: 'image', invalidate: true });
        if (result.result !== 'ok' && result.result !== 'not found') return send(res, 502, 'delete failed');
        return send(res, 200, 'ok');
      }
    }

    return send(res, 404, 'Not found');
  } catch (error) {
    console.error('Request failed:', error.message);
    return send(res, 500, 'Server error');
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`GF pages running on port ${PORT}`);
});
