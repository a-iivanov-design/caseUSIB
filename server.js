import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@libsql/client';
import crypto from 'crypto';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const BOT_TOKEN = process.env.BOT_TOKEN || '8858536573:AAEMimZ3ynfL9Z_4IJT-57JOlcecACWmye4';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN || '',
});

async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT,
      last_spin TEXT,
      is_banned INTEGER DEFAULT 0
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS prizes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      icon TEXT,
      rarity TEXT,
      weight INTEGER,
      promo_prefix TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      prize_name TEXT,
      icon TEXT,
      promo TEXT,
      won_at TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      username TEXT,
      is_super INTEGER DEFAULT 0
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS admin_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id TEXT,
      admin_username TEXT,
      action TEXT,
      details TEXT,
      created_at TEXT
    )
  `);

  const adminCheck = await db.execute(`SELECT COUNT(*) as count FROM admins`);
  if (adminCheck.rows[0].count === 0) {
    await db.execute({
      sql: `INSERT INTO admins (id, username, is_super) VALUES (?, ?, ?)`,
      args: ['ropogku_id', 'ropogku', 1]
    });
  }
}
initDb();

async function logAdminAction(telegramUser, action, details) {
  try {
    const adminId = String(telegramUser.id);
    const adminUsername = telegramUser.username ? telegramUser.username.replace('@', '').toLowerCase() : adminId;
    const nowIso = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO admin_logs (admin_id, admin_username, action, details, created_at) VALUES (?, ?, ?, ?, ?)`,
      args: [adminId, adminUsername, action, details, nowIso]
    });
  } catch (e) {
    console.error('Log error:', e);
  }
}

function verifyTelegramWebAppData(initData) {
  if (!initData || BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    if (BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
      try {
        const urlParams = new URLSearchParams(initData);
        const userObj = JSON.parse(urlParams.get('user') || '{}');
        if (userObj.id) {
          return { isValid: true, user: userObj };
        }
      } catch (e) {
        console.error('Auth parse error:', e);
      }
    }
    return { isValid: false };
  }

  try {
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');

    const paramsList = [];
    urlParams.sort();
    for (const [key, value] of urlParams.entries()) {
      paramsList.push(`${key}=${value}`);
    }
    const dataCheckString = paramsList.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculatedHash !== hash) {
      return { isValid: false };
    }

    const userStr = urlParams.get('user');
    const user = userStr ? JSON.parse(userStr) : null;
    return { isValid: true, user };
  } catch (e) {
    console.error('Telegram data verification error:', e);
    return { isValid: false };
  }
}

async function authMiddleware(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  const verification = verifyTelegramWebAppData(initData);

  if (!verification.isValid || !verification.user) {
    return res.status(401).json({ error: 'Unauthorized: invalid initData' });
  }

  req.telegramUser = verification.user;
  next();
}

async function verifyAdminByTelegramUser(telegramUser) {
  if (!telegramUser) return { isAdmin: false, isSuper: false };
  const username = telegramUser.username ? telegramUser.username.replace('@', '').toLowerCase() : '';
  const userId = String(telegramUser.id);
  
  if (username === 'ropogku' || userId === 'ropogku') {
    return { isAdmin: true, isSuper: true };
  }

  const res = await db.execute({
    sql: `SELECT * FROM admins WHERE id = ? OR LOWER(username) = ?`,
    args: [userId, username]
  });
  if (res.rows.length === 0) return { isAdmin: false, isSuper: false };
  return {
    isAdmin: true,
    isSuper: res.rows[0].is_super === 1
  };
}

app.get('/', (req, res) => {
  res.send('Case Lounge Server is active and running!');
});

app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

app.post('/api/admin/upload-image', authMiddleware, async (req, res) => {
  try {
    const admin = await verifyAdminByTelegramUser(req.telegramUser);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const { image, filename } = req.body;
    if (!image) return res.status(400).json({ error: 'No image provided' });

    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
    const ext = filename ? path.extname(filename) : '.jpg';
    const uniqueName = `img_${Date.now()}${ext}`;
    const filePath = path.join(uploadsDir, uniqueName);

    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
    await logAdminAction(req.telegramUser, 'UPLOAD_IMAGE', `Uploaded file: ${uniqueName}`);

    res.json({ success: true, url: `/uploads/${uniqueName}` });
  } catch (e) {
    console.error('Upload Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/status', authMiddleware, async (req, res) => {
  try {
    const userId = String(req.telegramUser.id);
    const cleanUsername = req.telegramUser.username ? req.telegramUser.username.replace('@', '').toLowerCase() : '';

    let userRes = await db.execute({
      sql: `SELECT * FROM users WHERE id = ?`,
      args: [userId]
    });

    let user = userRes.rows[0];

    if (!user) {
      res.json({ isBanned: false, canSpin: true });
      return;
    }

    if (user.is_banned === 1 && cleanUsername !== 'ropogku') {
      return res.json({ isBanned: true });
    }

    let canSpin = true;
    let nextSpinTime = '';

    if (user.last_spin) {
      const lastSpinTime = new Date(user.last_spin).getTime();
      const now = Date.now();
      const cooldownTime = 24 * 60 * 60 * 1000;
      const timePassed = now - lastSpinTime;

      if (timePassed < cooldownTime) {
        canSpin = false;
        const timeLeft = cooldownTime - timePassed;
        
        const hoursLeft = Math.floor(timeLeft / (1000 * 60 * 60));
        const minutesLeft = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
        
        if (hoursLeft > 0) {
          nextSpinTime = `${hoursLeft} ч ${minutesLeft} мин`;
        } else {
          nextSpinTime = `${minutesLeft} мин`;
        }
      }
    }

    res.json({ isBanned: false, canSpin, nextSpinTime });
  } catch (e) {
    console.error('API Status Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/check', authMiddleware, async (req, res) => {
  try {
    const adminData = await verifyAdminByTelegramUser(req.telegramUser);
    res.json(adminData);
  } catch (e) {
    console.error('Admin Check Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/spin', authMiddleware, async (req, res) => {
  try {
    const userId = String(req.telegramUser.id);
    const cleanUsername = req.telegramUser.username ? req.telegramUser.username.replace('@', '').toLowerCase() : '';

    let userRes = await db.execute({
      sql: `SELECT * FROM users WHERE id = ?`,
      args: [userId]
    });

    let user = userRes.rows[0];

    if (user && user.is_banned === 1 && cleanUsername !== 'ropogku') {
      return res.status(403).json({ isBanned: true, error: 'Аккаунт заблокирован' });
    }

    if (user && user.last_spin) {
      const lastSpinTime = new Date(user.last_spin).getTime();
      const now = Date.now();
      const cooldownTime = 24 * 60 * 60 * 1000;
      
      if ((now - lastSpinTime) < cooldownTime) {
        return res.status(400).json({ error: 'Кейс можно открывать раз в 24 часа' });
      }
    }

    const prizesRes = await db.execute(`SELECT * FROM prizes`);
    const prizes = prizesRes.rows;
    if (prizes.length === 0) {
      return res.status(400).json({ error: 'Призы не настроены администратором' });
    }

    let totalWeight = prizes.reduce((sum, p) => sum + p.weight, 0);
    let randomWeight = Math.random() * totalWeight;
    let chosenPrize = prizes[0];

    for (let p of prizes) {
      if (randomWeight < p.weight) {
        chosenPrize = p;
        break;
      }
      randomWeight -= p.weight;
    }

    const promoCode = `${chosenPrize.promo_prefix || 'CYBER'}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    const nowIso = new Date().toISOString();

    if (user) {
      await db.execute({
        sql: `UPDATE users SET last_spin = ?, username = ? WHERE id = ?`,
        args: [nowIso, cleanUsername, userId]
      });
    } else {
      await db.execute({
        sql: `INSERT INTO users (id, username, last_spin, is_banned) VALUES (?, ?, ?, 0)`,
        args: [userId, cleanUsername, nowIso]
      });
    }

    await db.execute({
      sql: `INSERT INTO inventory (user_id, prize_name, icon, promo, won_at) VALUES (?, ?, ?, ?, ?)`,
      args: [userId, chosenPrize.name, chosenPrize.icon || '🎁', promoCode, nowIso]
    });

    res.json({
      prize: {
        name: chosenPrize.name,
        icon: chosenPrize.icon,
        rarity: chosenPrize.rarity
      },
      promo: promoCode
    });
  } catch (e) {
    console.error('Spin Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/inventory', authMiddleware, async (req, res) => {
  try {
    const userId = String(req.telegramUser.id);

    const itemsRes = await db.execute({
      sql: `SELECT * FROM inventory WHERE user_id = ? ORDER BY id DESC`,
      args: [userId]
    });

    const now = new Date();
    const validItems = [];

    for (const item of itemsRes.rows) {
      const wonAt = new Date(item.won_at);
      const diffHours = (now - wonAt) / (1000 * 60 * 60);

      if (diffHours >= 48) {
        await db.execute({
          sql: `DELETE FROM inventory WHERE id = ?`,
          args: [item.id]
        });
      } else {
        validItems.push({
          ...item,
          hoursLeft: Math.ceil(48 - diffHours)
        });
      }
    }

    res.json({ items: validItems });
  } catch (e) {
    console.error('Inventory Get Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/inventory/delete', authMiddleware, async (req, res) => {
  try {
    const userId = String(req.telegramUser.id);
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: 'Missing parameters' });

    await db.execute({
      sql: `DELETE FROM inventory WHERE id = ? AND user_id = ?`,
      args: [Number(itemId), userId]
    });

    res.json({ success: true });
  } catch (e) {
    console.error('Inventory Delete Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/prizes', authMiddleware, async (req, res) => {
  try {
    const admin = await verifyAdminByTelegramUser(req.telegramUser);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const prizesRes = await db.execute(`SELECT * FROM prizes`);
    res.json({ prizes: prizesRes.rows });
  } catch (e) {
    console.error('Admin Prizes Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/add-prize', authMiddleware, async (req, res) => {
  try {
    const admin = await verifyAdminByTelegramUser(req.telegramUser);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const { name, icon, rarity, weight, promo_prefix } = req.body;
    await db.execute({
      sql: `INSERT INTO prizes (name, icon, rarity, weight, promo_prefix) VALUES (?, ?, ?, ?, ?)`,
      args: [name, icon || '🎁', rarity || 'common', Number(weight) || 1, promo_prefix || 'PROMO']
    });
    await logAdminAction(req.telegramUser, 'ADD_PRIZE', `Added prize: ${name}`);
    res.json({ success: true });
  } catch (e) {
    console.error('Add Prize Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/delete-prize', authMiddleware, async (req, res) => {
  try {
    const admin = await verifyAdminByTelegramUser(req.telegramUser);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const { prizeId } = req.body;
    await db.execute({
      sql: `DELETE FROM prizes WHERE id = ?`,
      args: [Number(prizeId)]
    });
    await logAdminAction(req.telegramUser, 'DELETE_PRIZE', `Deleted prize ID: ${prizeId}`);
    res.json({ success: true });
  } catch (e) {
    console.error('Delete Prize Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/update-prize', authMiddleware, async (req, res) => {
  try {
    const admin = await verifyAdminByTelegramUser(req.telegramUser);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const { prizeId, weight } = req.body;
    await db.execute({
      sql: `UPDATE prizes SET weight = ? WHERE id = ?`,
      args: [Number(weight), Number(prizeId)]
    });
    res.json({ success: true });
  } catch (e) {
    console.error('Update Prize Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/stats', authMiddleware, async (req, res) => {
  try {
    const admin = await verifyAdminByTelegramUser(req.telegramUser);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const usersCount = await db.execute(`SELECT COUNT(*) as count FROM users`);
    const bannedCount = await db.execute(`SELECT COUNT(*) as count FROM users WHERE is_banned = 1`);
    const spinsCount = await db.execute(`SELECT COUNT(*) as count FROM inventory`);

    res.json({
      totalUsers: usersCount.rows[0].count,
      bannedUsers: bannedCount.rows[0].count,
      totalSpins: spinsCount.rows[0].count
    });
  } catch (e) {
    console.error('Admin Stats Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/banned-list', authMiddleware, async (req, res) => {
  try {
    const admin = await verifyAdminByTelegramUser(req.telegramUser);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const banned = await db.execute(`SELECT id, username FROM users WHERE is_banned = 1 AND LOWER(username) != 'ropogku'`);
    res.json({ bannedUsers: banned.rows });
  } catch (e) {
    console.error('Banned List Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/users-list', authMiddleware, async (req, res) => {
  try {
    const admin = await verifyAdminByTelegramUser(req.telegramUser);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const users = await db.execute(`SELECT id, username, is_banned FROM users`);
    res.json({ users: users.rows });
  } catch (e) {
    console.error('Users List Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/ban', authMiddleware, async (req, res) => {
  try {
    const admin = await verifyAdminByTelegramUser(req.telegramUser);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const { targetIdentifier, banState } = req.body;
    const cleanId = String(targetIdentifier).replace('@', '').toLowerCase();

    if (cleanId === 'ropogku' || cleanId === '8858536573') {
      return res.status(400).json({ error: 'Нельзя заблокировать главного администратора' });
    }

    await db.execute({
      sql: `UPDATE users SET is_banned = ? WHERE id = ? OR LOWER(username) = ?`,
      args: [Number(banState), String(targetIdentifier), cleanId]
    });
    await logAdminAction(req.telegramUser, 'SET_BAN', `Target: ${targetIdentifier}, State: ${banState}`);
    res.json({ success: true });
  } catch (e) {
    console.error('Ban Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/delete-user', authMiddleware, async (req, res) => {
  try {
    const admin = await verifyAdminByTelegramUser(req.telegramUser);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const { targetIdentifier } = req.body;
    const cleanUser = targetIdentifier ? String(targetIdentifier).replace('@', '').toLowerCase() : '';
    
    if (cleanUser === 'ropogku') {
      return res.status(400).json({ error: 'Нельзя удалить главного администратора' });
    }

    const userRes = await db.execute({
      sql: `SELECT id FROM users WHERE LOWER(username) = ? OR id = ?`,
      args: [cleanUser, String(targetIdentifier)]
    });

    if (userRes.rows.length > 0) {
      const foundUserId = userRes.rows[0].id;
      await db.execute({
        sql: `DELETE FROM inventory WHERE user_id = ?`,
        args: [foundUserId]
      });
      await db.execute({
        sql: `DELETE FROM users WHERE id = ?`,
        args: [foundUserId]
      });
    }

    await logAdminAction(req.telegramUser, 'DELETE_USER', `Deleted user: ${targetIdentifier}`);
    res.json({ success: true });
  } catch (e) {
    console.error('Delete User Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/reset-timer', authMiddleware, async (req, res) => {
  try {
    const admin = await verifyAdminByTelegramUser(req.telegramUser);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const { targetIdentifier } = req.body;
    const cleanId = String(targetIdentifier).replace('@', '').toLowerCase();
    await db.execute({
      sql: `UPDATE users SET last_spin = NULL WHERE id = ? OR LOWER(username) = ?`,
      args: [String(targetIdentifier), cleanId]
    });
    await logAdminAction(req.telegramUser, 'RESET_TIMER', `Reset timer for: ${targetIdentifier}`);
    res.json({ success: true });
  } catch (e) {
    console.error('Reset Timer Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/list', authMiddleware, async (req, res) => {
  try {
    const admin = await verifyAdminByTelegramUser(req.telegramUser);
    if (!admin.isAdmin) return res.status(403).json({ error: 'Access denied' });

    const admins = await db.execute(`SELECT id, username, is_super FROM admins`);
    res.json({ admins: admins.rows });
  } catch (e) {
    console.error('Admin List Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/logs', authMiddleware, async (req, res) => {
  try {
    const admin = await verifyAdminByTelegramUser(req.telegramUser);
    if (!admin.isSuper) return res.status(403).json({ error: 'Access denied: Super admin only' });

    const logsRes = await db.execute(`SELECT * FROM admin_logs ORDER BY id DESC LIMIT 50`);
    res.json({ logs: logsRes.rows });
  } catch (e) {
    console.error('Admin Logs Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/add-admin', authMiddleware, async (req, res) => {
  try {
    const admin = await verifyAdminByTelegramUser(req.telegramUser);
    if (!admin.isSuper) return res.status(403).json({ error: 'Only super admin can add admins' });

    const { targetIdentifier } = req.body;
    if (!targetIdentifier) return res.status(400).json({ error: 'Missing targetIdentifier' });

    const cleanId = String(targetIdentifier).replace('@', '').toLowerCase();

    const userRes = await db.execute({
      sql: `SELECT id, username FROM users WHERE id = ? OR LOWER(username) = ?`,
      args: [String(targetIdentifier), cleanId]
    });

    let adminId = String(targetIdentifier);
    let adminUsername = cleanId;

    if (userRes.rows.length > 0) {
      adminId = userRes.rows[0].id;
      adminUsername = userRes.rows[0].username || adminId;
    }

    await db.execute({
      sql: `INSERT OR IGNORE INTO admins (id, username, is_super) VALUES (?, ?, 0)`,
      args: [adminId, adminUsername]
    });
    await logAdminAction(req.telegramUser, 'ADD_ADMIN', `Added admin: ${adminUsername} (${adminId})`);
    res.json({ success: true });
  } catch (e) {
    console.error('Add Admin Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/remove-admin', authMiddleware, async (req, res) => {
  try {
    const admin = await verifyAdminByTelegramUser(req.telegramUser);
    if (!admin.isSuper) return res.status(403).json({ error: 'Only super admin can remove admins' });

    const { targetIdentifier } = req.body;
    const cleanUser = String(targetIdentifier).replace('@', '').toLowerCase();
    if (cleanUser === 'ropogku' || cleanUser === 'ropogku_id') {
      return res.status(400).json({ error: 'Нельзя удалить главного администратора' });
    }
    await db.execute({
      sql: `DELETE FROM admins WHERE id = ? OR LOWER(username) = ?`,
      args: [String(targetIdentifier), cleanUser]
    });
    await logAdminAction(req.telegramUser, 'REMOVE_ADMIN', `Removed admin: ${targetIdentifier}`);
    res.json({ success: true });
  } catch (e) {
    console.error('Remove Admin Error:', e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
