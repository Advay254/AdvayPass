'use strict';
require('dotenv').config();

const express  = require('express');
const { nanoid } = require('nanoid');
const path     = require('path');
const fs       = require('fs').promises;
const crypto   = require('crypto');
const QRCode   = require('qrcode');

const app  = express();
const PORT = process.env.PORT || 3000;

const SMARTLINK_URL = process.env.SMARTLINK_URL
  || 'https://millionairelucidlytransmitted.com/qfbmxh4gax?key=bc08f1d488a15a751b9aec38cdf96e49';
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════════════════════
//  DATABASE  (PostgreSQL via pg → Supabase, or JSON file)
// ════════════════════════════════════════════════════════

let pool   = null;
let useDB  = false;

if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool  = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  useDB = true;
  console.log('✅ PostgreSQL connected');
}

async function initDB() {
  if (!useDB) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS links (
        code               TEXT PRIMARY KEY,
        url                TEXT        NOT NULL,
        expires_at         TIMESTAMPTZ,
        created_at         TIMESTAMPTZ DEFAULT NOW(),
        analytics_password TEXT
      );

      CREATE TABLE IF NOT EXISTS clicks (
        id         BIGSERIAL   PRIMARY KEY,
        link_code  TEXT        REFERENCES links(code) ON DELETE CASCADE,
        clicked_at TIMESTAMPTZ DEFAULT NOW(),
        ip_hash    TEXT,
        country    TEXT,
        device     TEXT,
        browser    TEXT,
        referrer   TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_clicks_link  ON clicks(link_code);
      CREATE INDEX IF NOT EXISTS idx_links_expiry ON links(expires_at);
    `);
    console.log('✅ Tables ready');
  } catch (err) {
    console.error('❌ DB init error:', err.message);
    useDB = false;
    console.warn('⚠️  Falling back to JSON storage');
  }
}

// ════════════════════════════════════════════════════════
//  JSON FALLBACK
// ════════════════════════════════════════════════════════

const DATA_DIR    = path.join(__dirname, 'data');
const LINKS_FILE  = path.join(DATA_DIR, 'links.json');
const CLICKS_FILE = path.join(DATA_DIR, 'clicks.json');

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  for (const f of [LINKS_FILE, CLICKS_FILE]) {
    try { await fs.access(f); } catch { await fs.writeFile(f, '{}'); }
  }
}

async function readJSON(file)       { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return {}; } }
async function writeJSON(file, obj) { await fs.writeFile(file, JSON.stringify(obj, null, 2)); }

// ════════════════════════════════════════════════════════
//  UNIFIED STORAGE API
// ════════════════════════════════════════════════════════

const storage = {

  async getLink(code) {
    if (useDB) {
      const { rows } = await pool.query('SELECT * FROM links WHERE code=$1', [code]);
      return rows[0] || null;
    }
    const l = await readJSON(LINKS_FILE);
    return l[code] || null;
  },

  async saveLink(code, data) {
    if (useDB) {
      await pool.query(
        `INSERT INTO links (code,url,expires_at,analytics_password) VALUES ($1,$2,$3,$4)`,
        [code, data.url, data.expires_at, data.analytics_password || null]
      );
      return;
    }
    const l = await readJSON(LINKS_FILE);
    l[code]  = { ...data, created_at: new Date().toISOString() };
    await writeJSON(LINKS_FILE, l);
  },

  async deleteLink(code) {
    if (useDB) { await pool.query('DELETE FROM links WHERE code=$1', [code]); return; }
    const [l, c] = await Promise.all([readJSON(LINKS_FILE), readJSON(CLICKS_FILE)]);
    delete l[code]; delete c[code];
    await Promise.all([writeJSON(LINKS_FILE, l), writeJSON(CLICKS_FILE, c)]);
  },

  async saveClick(code, data) {
    if (useDB) {
      await pool.query(
        `INSERT INTO clicks (link_code,ip_hash,country,device,browser,referrer)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [code, data.ip_hash, data.country, data.device, data.browser, data.referrer]
      );
      return;
    }
    const c = await readJSON(CLICKS_FILE);
    if (!c[code]) c[code] = [];
    c[code].push({ ...data, clicked_at: new Date().toISOString() });
    await writeJSON(CLICKS_FILE, c);
  },

  async getClicks(code) {
    if (useDB) {
      const { rows } = await pool.query(
        'SELECT * FROM clicks WHERE link_code=$1 ORDER BY clicked_at DESC', [code]
      );
      return rows;
    }
    const c = await readJSON(CLICKS_FILE);
    return (c[code] || []).sort((a,b) => new Date(b.clicked_at) - new Date(a.clicked_at));
  },

  async deleteExpired() {
    if (useDB) {
      const { rowCount } = await pool.query(
        `DELETE FROM links WHERE expires_at IS NOT NULL AND expires_at < NOW()`
      );
      if (rowCount > 0) console.log(`🗑️  Auto-deleted ${rowCount} expired links`);
      return;
    }
    const [l, c] = await Promise.all([readJSON(LINKS_FILE), readJSON(CLICKS_FILE)]);
    const now = new Date();
    let n = 0;
    for (const code of Object.keys(l)) {
      if (l[code].expires_at && new Date(l[code].expires_at) < now) {
        delete l[code]; delete c[code]; n++;
      }
    }
    if (n > 0) {
      await Promise.all([writeJSON(LINKS_FILE, l), writeJSON(CLICKS_FILE, c)]);
      console.log(`🗑️  Auto-deleted ${n} expired links`);
    }
  }
};

// ════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════

const hashIP = ip =>
  crypto.createHash('sha256').update(ip + 'advaypass-salt-2025').digest('hex').slice(0, 16);

function parseUA(ua = '') {
  const device  = /mobile|android|iphone|ipad|tablet/i.test(ua) ? 'Mobile' : 'Desktop';
  const u       = ua.toLowerCase();
  let browser   = 'Other';
  if      (u.includes('edg'))    browser = 'Edge';
  else if (u.includes('opr') || u.includes('opera')) browser = 'Opera';
  else if (u.includes('chrome')) browser = 'Chrome';
  else if (u.includes('firefox'))browser = 'Firefox';
  else if (u.includes('safari')) browser = 'Safari';
  return { device, browser };
}

async function geoIP(ip) {
  if (!ip || ['::1','127.0.0.1'].includes(ip) || ip.startsWith('192.168') || ip.startsWith('10.'))
    return 'Local';
  try {
    const r = await fetch(`http://ip-api.com/json/${ip}?fields=country`, { signal: AbortSignal.timeout(3000) });
    const d = await r.json();
    return d.country || 'Unknown';
  } catch { return 'Unknown'; }
}

const clientIP = req =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  || req.headers['x-real-ip']
  || req.socket?.remoteAddress
  || '0.0.0.0';

// ════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════

// --- Health check ---
app.get('/health', (_req, res) => res.json({
  status: 'ok',
  uptime: Math.floor(process.uptime()),
  storage: useDB ? 'supabase' : 'json',
  timestamp: new Date().toISOString()
}));

// --- Client config (exposes smartlink safely) ---
app.get('/api/config', (_req, res) => res.json({ smartlink: SMARTLINK_URL }));

// --- Shorten ---
app.post('/api/shorten', async (req, res) => {
  try {
    const { url, expiry_days, analytics_password } = req.body;

    if (!url || !/^https?:\/\/.+/.test(url.trim()))
      return res.status(400).json({ error: 'Please enter a valid URL starting with http:// or https://' });

    const days      = Math.max(1, Math.min(365, parseInt(expiry_days) || 7));
    const expires_at = new Date(Date.now() + days * 86_400_000).toISOString();
    const ap        = (analytics_password || '').trim().slice(0, 8) || null;
    const code      = nanoid(8);

    await storage.saveLink(code, { url: url.trim(), expires_at, analytics_password: ap });

    const shortUrl = `${SITE_URL}/${code}`;
    const qrSvg   = await QRCode.toString(shortUrl, {
      type: 'svg',
      errorCorrectionLevel: 'H',
      color: { dark: '#1e40af', light: '#ffffff' },
      margin: 1,
      width: 300
    });

    res.json({ shortUrl, code, expires_at, days, qrSvg, analyticsUrl: `${SITE_URL}/analytics/${code}`, hasPassword: !!ap });
  } catch (err) {
    console.error('Shorten error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// --- Analytics password check ---
app.post('/api/analytics/:code/auth', async (req, res) => {
  const link = await storage.getLink(req.params.code);
  if (!link)                                        return res.status(404).json({ error: 'Link not found' });
  if (!link.analytics_password)                     return res.json({ access: true });
  if (link.analytics_password === req.body.password) return res.json({ access: true });
  return res.status(401).json({ error: 'Incorrect password' });
});

// --- Analytics data ---
app.get('/api/analytics/:code', async (req, res) => {
  const { code } = req.params;
  const { password } = req.query;

  const link = await storage.getLink(code);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  if (link.analytics_password && link.analytics_password !== password)
    return res.status(401).json({ needsPassword: true });

  const clicks      = await storage.getClicks(code);
  const totalClicks = clicks.length;
  const uniqueClicks = new Set(clicks.map(c => c.ip_hash)).size;

  const byCountry = {}, byDevice = {}, byBrowser = {}, byDay = {};
  clicks.forEach(c => {
    if (c.country) byCountry[c.country] = (byCountry[c.country] || 0) + 1;
    if (c.device)  byDevice[c.device]   = (byDevice[c.device]   || 0) + 1;
    if (c.browser) byBrowser[c.browser] = (byBrowser[c.browser] || 0) + 1;
    const day = (c.clicked_at || '').slice(0, 10);
    if (day) byDay[day] = (byDay[day] || 0) + 1;
  });

  res.json({
    link: { code, url: link.url, created_at: link.created_at, expires_at: link.expires_at },
    stats: { totalClicks, uniqueClicks, byCountry, byDevice, byBrowser, byDay, recentClicks: clicks.slice(0, 10) }
  });
});

// --- Analytics HTML page ---
app.get('/analytics/:code', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'analytics.html'))
);

// --- Short code redirect (must come last) ---
app.get('/:code', async (req, res) => {
  const { code } = req.params;
  if (/^(api|analytics|favicon\.ico|robots\.txt|sitemap\.xml)/.test(code))
    return res.status(404).send('Not found');

  let link;
  try { link = await storage.getLink(code); }
  catch { return res.redirect('/expired.html?reason=error'); }

  if (!link) return res.redirect('/expired.html?reason=notfound');

  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    await storage.deleteLink(code).catch(() => {});
    return res.redirect('/expired.html?reason=expired');
  }

  // Record click asynchronously — never block the redirect
  const ip      = clientIP(req);
  const { device, browser } = parseUA(req.headers['user-agent']);
  const referrer = req.headers['referer'] || '';
  const ip_hash  = hashIP(ip);

  geoIP(ip).then(country =>
    storage.saveClick(code, { ip_hash, country, device, browser, referrer })
  ).catch(() => {
    storage.saveClick(code, { ip_hash, country: 'Unknown', device, browser, referrer });
  });

  res.redirect(`/wait.html?dest=${encodeURIComponent(link.url)}&code=${code}`);
});

// ════════════════════════════════════════════════════════
//  SCHEDULED CLEANUP  (every hour)
// ════════════════════════════════════════════════════════

setInterval(() => storage.deleteExpired().catch(console.error), 60 * 60 * 1000);

// ════════════════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════════════════

async function start() {
  if (!useDB) await ensureDataDir();
  await initDB();
  app.listen(PORT, () => {
    const mode = useDB ? 'PostgreSQL (Supabase)' : 'JSON file';
    console.log(`\n🚀 AdvayPass is live → http://localhost:${PORT}`);
    console.log(`💾 Storage: ${mode}`);
    console.log(`🔗 Smartlink: ${SMARTLINK_URL.slice(0, 60)}...\n`);
  });
}

start().catch(err => { console.error('Startup error:', err); process.exit(1); });
