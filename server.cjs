
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v2: cloudinary } = require('cloudinary');

const PORT = Number(process.env.PORT) || 3000;
const PASSWORD = process.env.ADMIN_PASSWORD;
const PUB = path.join(__dirname, 'public');
const MAX_UPLOAD_SIZE = 15 * 1024 * 1024;
const CLOUD_FOLDER = 'gf-pages';

if (!PASSWORD || PASSWORD.length < 12) {
  console.error('Set ADMIN_PASSWORD to a unique password of at least 12 characters.');
  process.exit(1);
}

if (
  !process.env.CLOUDINARY_CLOUD_NAME ||
  !process.env.CLOUDINARY_API_KEY ||
  !process.env.CLOUDINARY_API_SECRET
) {
  console.error('Missing Cloudinary environment variables.');
  process.exit(1);
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

const sessions = new Map();
const failedLogins = new Map();

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(body);
}

function getCookies(req) {
  const result = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) result[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return result;
}

function getSession(req) {
  const sid = getCookies(req).sid;
  const session = sid && sessions.get(sid);
  if (!session) return null;
  if (session.expires < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  return session;
}

function sameHash(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let finished = false;

    req.on('data', chunk => {
      if (finished) return;
      size += chunk.length;
      if (size > limit) {
        finished = true;
        reject(new Error('BODY_TOO_LARGE'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!finished) resolve(Buffer.concat(chunks));
    });

    req.on('error', err => {
      if (!finished) {
        finished = true;
        reject(err);
      }
    });
  });
}

function detectImageType(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
  ]))) return 'png';
  if (
    buffer.subarray(0, 4).toString() === 'RIFF' &&
    buffer.subarray(8, 12).toString() === 'WEBP'
  ) return 'webp';
  if (buffer.subarray(0, 3).toString() === 'GIF') return 'gif';
  if (buffer.subarray(4, 8).toString() === 'ftyp') return 'heic';
  return null;
}

function uploadToCloudinary(buffer, kind) {
  return new Promise((resolve, reject) => {
    const publicId =
      `${Date.now()}-${kind}-${crypto.randomBytes(6).toString('hex')}`;

    const stream = cloudinary.uploader.upload_stream({
      folder: CLOUD_FOLDER,
      public_id: publicId,
      resource_type: 'image',
      tags: ['gf-pages', kind]
    }, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });

    stream.end(buffer);
  });
}

function validPublicId(id) {
  return typeof id === 'string' &&
    /^gf-pages\/\d+-(cute|kiss)-[0-9a-f]{12}$/.test(id);
}

function clientIp(req) {
  // Use the direct socket address for rate limiting.
  return req.socket.remoteAddress || 'unknown';
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  try {
    // Girlfriend's page
    if (
      req.method === 'GET' &&
      (url.pathname === '/' || url.pathname === '/index.html')
    ) {
      return send(
        res, 200,
        fs.readFileSync(path.join(PUB, 'index.html')),
        'text/html; charset=utf-8'
      );
    }

    // Receive a photo and store it in Cloudinary.
    if (req.method === 'POST' && url.pathname === '/upload') {
      const kind = url.searchParams.get('kind') === 'kiss' ? 'kiss' : 'cute';

      let body;
      try {
        body = await readBody(req, MAX_UPLOAD_SIZE);
      } catch (err) {
        return send(
          res,
          err.message === 'BODY_TOO_LARGE' ? 413 : 400,
          'Upload too large or invalid.'
        );
      }

      if (!detectImageType(body)) {
        return send(res, 400, 'Unsupported image.');
      }

      try {
        const result = await uploadToCloudinary(body, kind);
        console.log('Photo uploaded:', result.public_id);
        return send(res, 200, 'ok');
      } catch (err) {
        console.error('Cloudinary upload failed:', err.message);
        return send(res, 502, 'Could not store photo.');
      }
    }

    // Admin page itself displays the login form.
    if (req.method === 'GET' && url.pathname === '/admin') {
      return send(
        res, 200,
        fs.readFileSync(path.join(PUB, 'admin.html')),
        'text/html; charset=utf-8'
      );
    }

    // Admin login
    if (req.method === 'POST' && url.pathname === '/admin/login') {
      const ip = clientIp(req);
      const failure = failedLogins.get(ip) || { count: 0, until: 0 };

      if (failure.until > Date.now()) {
        return send(res, 429, 'locked');
      }

      let supplied = '';
      try {
        supplied = JSON.parse(
          (await readBody(req, 2000)).toString()
        ).password || '';
      } catch {
        return send(res, 400, 'Invalid request.');
      }

      if (!sameHash(supplied, PASSWORD)) {
        failure.count++;
        if (failure.count >= 5) {
          failure.count = 0;
          failure.until = Date.now() + 10 * 60 * 1000;
        }
        failedLogins.set(ip, failure);
        return send(res, 401, 'Incorrect password.');
      }

      failedLogins.delete(ip);
      const sid = crypto.randomBytes(32).toString('hex');
      sessions.set(sid, { expires: Date.now() + 24 * 60 * 60 * 1000 });

      const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      res.setHeader(
        'Set-Cookie',
        `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secure}`
      );
      return send(res, 200, 'ok');
    }

    // Logout
    if (req.method === 'POST' && url.pathname === '/admin/logout') {
      const sid = getCookies(req).sid;
      if (sid) sessions.delete(sid);
      const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      res.setHeader(
        'Set-Cookie',
        `sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`
      );
      return send(res, 200, 'ok');
    }

    // All remaining /admin/* endpoints require a valid session.
    if (url.pathname.startsWith('/admin/')) {
      if (!getSession(req)) return send(res, 401, 'login required');

      // List photos
      if (req.method === 'GET' && url.pathname === '/admin/list') {
        const result = await cloudinary.api.resources({
          type: 'upload',
          prefix: `${CLOUD_FOLDER}/`,
          max_results: 500,
          resource_type: 'image'
        });

        const files = (result.resources || [])
          .filter(item => validPublicId(item.public_id))
          .map(item => {
            const match = item.public_id.match(
              /^gf-pages\/(\d+)-(cute|kiss)-[0-9a-f]{12}$/
            );
            return {
              name: item.public_id,
              kind: match[2],
              time: Number(match[1])
            };
          })
          .sort((a, b) => b.time - a.time);

        return send(
          res, 200, JSON.stringify(files),
          'application/json; charset=utf-8'
        );
      }

      // Return a photo URL only after authentication.
      if (req.method === 'GET' && url.pathname.startsWith('/admin/img/')) {
        const publicId = decodeURIComponent(
          url.pathname.slice('/admin/img/'.length)
        );

        if (!validPublicId(publicId)) return send(res, 404, 'Not found.');

        const result = await cloudinary.api.resource(publicId, {
          resource_type: 'image'
        });

        res.writeHead(302, {
          Location: result.secure_url,
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer'
        });
        return res.end();
      }

      // Delete photo from Cloudinary
      if (req.method === 'POST' && url.pathname === '/admin/delete') {
        let publicId = '';
        try {
          publicId = new URLSearchParams(
            (await readBody(req, 2000)).toString()
          ).get('name') || '';
        } catch {
          return send(res, 400, 'Invalid request.');
        }

        if (!validPublicId(publicId)) {
          return send(res, 400, 'Invalid photo.');
        }

        const result = await cloudinary.uploader.destroy(publicId, {
          resource_type: 'image',
          invalidate: true
        });

        if (result.result !== 'ok' && result.result !== 'not found') {
          return send(res, 502, 'Could not delete photo.');
        }
        return send(res, 200, 'ok');
      }
    }

    return send(res, 404, 'Not found.');
  } catch (err) {
    console.error('Request failed:', err.message);
    return send(res, 500, 'Server error.');
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`GF Pages running on port ${PORT}`);
});
