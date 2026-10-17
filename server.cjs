// Run:  node server.js YOUR_SECRET_PASSWORD
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const PASSWORD = process.argv[2] || process.env.ADMIN_PASSWORD;
if (!PASSWORD || PASSWORD.length < 6) { console.error('Usage: node server.js YOUR_PASSWORD   (at least 6 characters)'); process.exit(1); }
const PUB = path.join(__dirname, 'public'), UP = path.join(__dirname, 'uploads');
fs.mkdirSync(UP, { recursive: true });

const MAX = 15 * 1024 * 1024;
const sessions = new Set();
const fails = new Map(); // ip -> {n, until}

function sniff(b) { // real image type from the first bytes
  if (b.length < 12) return null;
  if (b[0] === 0xFF && b[1] === 0xD8) return 'jpg';
  if (b.slice(0, 8).equals(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]))) return 'png';
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'webp';
  if (b.slice(0, 3).toString() === 'GIF') return 'gif';
  if (b.slice(4, 8).toString() === 'ftyp') return 'heic';
  return null;
}
const MIME = { jpg:'image/jpeg', png:'image/png', webp:'image/webp', gif:'image/gif', heic:'image/heic' };
const ip = req => req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(x => x[0]));
const authed = req => sessions.has(cookie(req).sid);
const send = (res, code, body, type = 'text/plain') => { res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }); res.end(body); };
const sameHash = (a, b) => { const x = crypto.createHash('sha256').update(a).digest(), y = crypto.createHash('sha256').update(b).digest(); return crypto.timingSafeEqual(x, y); };

function readBody(req, limit) {
  return new Promise((ok, bad) => {
    const parts = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { bad(new Error('too big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', bad);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // ----- her page -----
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html'))
      return send(res, 200, fs.readFileSync(path.join(PUB, 'index.html')), 'text/html; charset=utf-8');

    if (req.method === 'POST' && url.pathname === '/upload') {
      const kind = url.searchParams.get('kind') === 'kiss' ? 'kiss' : 'cute';
      const body = await readBody(req, MAX);
      const ext = sniff(body);
      if (!ext) return send(res, 400, 'not an image');
      const name = Date.now() + '-' + kind + '-' + crypto.randomBytes(3).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(UP, name), body);
      console.log('📸 New photo:', name);
      return send(res, 200, 'ok');
    }

    // ----- admin (only you) -----
    if (url.pathname === '/admin' && req.method === 'GET')
      return send(res, 200, fs.readFileSync(path.join(PUB, 'admin.html')), 'text/html; charset=utf-8');

    if (url.pathname === '/admin/login' && req.method === 'POST') {
      const f = fails.get(ip(req)) || { n: 0, until: 0 };
      if (f.until > Date.now()) return send(res, 429, 'locked');
      let pw = ''; try { pw = JSON.parse((await readBody(req, 2000)).toString()).password || ''; } catch {}
      if (!sameHash(pw, PASSWORD)) { f.n++; if (f.n >= 5) { f.until = Date.now() + 10 * 60000; f.n = 0; } fails.set(ip(req), f); return send(res, 401, 'no'); }
      fails.delete(ip(req));
      const sid = crypto.randomBytes(24).toString('hex'); sessions.add(sid);
      res.setHeader('Set-Cookie', 'sid=' + sid + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000');
      return send(res, 200, 'ok');
    }
    if (url.pathname === '/admin/logout' && req.method === 'POST') { sessions.delete(cookie(req).sid); return send(res, 200, 'ok'); }

    if (url.pathname.startsWith('/admin/')) {
      if (!authed(req)) return send(res, 401, 'login required');
      if (url.pathname === '/admin/list') {
        const files = fs.readdirSync(UP).filter(n => /^\d+-(cute|kiss)-[0-9a-f]+\.\w+$/.test(n)).sort().reverse()
          .map(n => ({ name: n, kind: n.split('-')[1], time: Number(n.split('-')[0]) }));
        return send(res, 200, JSON.stringify(files), 'application/json');
      }
      if (url.pathname.startsWith('/admin/img/')) {
        const n = path.basename(decodeURIComponent(url.pathname.slice(11)));
        if (!/^\d+-(cute|kiss)-[0-9a-f]+\.\w+$/.test(n) || !fs.existsSync(path.join(UP, n))) return send(res, 404, 'nope');
        return send(res, 200, fs.readFileSync(path.join(UP, n)), MIME[n.split('.').pop()] || 'application/octet-stream');
      }
      if (url.pathname === '/admin/delete' && req.method === 'POST') {
        const n = path.basename(url.searchParams.get('name') || '');
        if (/^\d+-(cute|kiss)-[0-9a-f]+\.\w+$/.test(n) && fs.existsSync(path.join(UP, n))) fs.unlinkSync(path.join(UP, n));
        return send(res, 200, 'ok');
      }
    }
    send(res, 404, 'Not found');
  } catch (e) { send(res, 500, 'error'); }
}).listen(PORT, () => {
  console.log('\n💌 Running!');
  console.log('   Her page : http://localhost:' + PORT + '/');
  console.log('   Your page: http://localhost:' + PORT + '/admin   (password protected)\n');
});
