import "dotenv/config";
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pg from "pg";
import bcrypt from "bcryptjs";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";

const { Pool } = pg;
const app = express();
const PORT = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === "production";
const PgSession = connectPgSimple(session);

if (!process.env.DATABASE_URL) console.warn("WARNING: DATABASE_URL belum diatur.");
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.warn("WARNING: SESSION_SECRET sebaiknya secret acak minimal 32 karakter.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false }
});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: isProduction ? [] : null
    }
  }
}));
app.use(express.json({ limit: "80kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(session({
  store: new PgSession({ pool, tableName: "user_sessions", createTableIfMissing: true }),
  name: "nusa.sid",
  secret: process.env.SESSION_SECRET || randomBytes(48).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === "true",
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));
app.use(express.static(path.join(__dirname, "public")));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: "draft-7", legacyHeaders: false });
const chatLimiter = rateLimit({ windowMs: 60 * 1000, limit: 15, standardHeaders: "draft-7", legacyHeaders: false });
const adminLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(60) NOT NULL,
      email VARCHAR(254) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role VARCHAR(10) NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS chats (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(120) NOT NULL DEFAULT 'Chat baru',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role VARCHAR(10) NOT NULL CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS chats_user_updated_idx ON chats(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS messages_chat_id_idx ON messages(chat_id, id);
  `);
}

function publicUser(user) {
  return { id: String(user.id), name: user.name, email: user.email, role: user.role, createdAt: user.created_at };
}
async function getUser(req) {
  if (!req.session.userId) return null;
  const result = await pool.query(
    "SELECT id, name, email, role, created_at FROM users WHERE id = $1",
    [req.session.userId]
  );
  return result.rows[0] || null;
}
async function requireAuth(req, res, next) {
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Silakan masuk terlebih dahulu." });
    req.user = user;
    next();
  } catch (e) { next(e); }
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Akses khusus admin." });
  next();
}
function validEmail(email) {
  return typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
async function ownsChat(chatId, userId) {
  const result = await pool.query("SELECT id FROM chats WHERE id = $1 AND user_id = $2", [chatId, userId]);
  return result.rowCount > 0;
}
function cleanTitle(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, 70) || "Chat baru";
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/me", async (req, res, next) => {
  try {
    const user = await getUser(req);
    res.json({ user: user ? publicUser(user) : null });
  } catch (e) { next(e); }
});

app.post("/api/auth/register", authLimiter, async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const adminToken = String(req.body?.adminToken || "");
    if (name.length < 2 || name.length > 60) return res.status(400).json({ error: "Nama harus 2–60 karakter." });
    if (!validEmail(email)) return res.status(400).json({ error: "Format email tidak valid." });
    if (password.length < 10 || password.length > 128) return res.status(400).json({ error: "Kata sandi harus 10–128 karakter." });
    const passwordHash = await bcrypt.hash(password, 12);
    let role = "user";
    const adminEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    const expectedToken = process.env.ADMIN_BOOTSTRAP_TOKEN || "";
    if (adminEmail && email === adminEmail && expectedToken.length >= 24 && sameSecret(adminToken, expectedToken)) {
      const existingAdmin = await pool.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
      if (existingAdmin.rowCount === 0) role = "admin";
    }
    const created = await pool.query(
      "INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id,name,email,role,created_at",
      [name, email, passwordHash, role]
    );
    req.session.userId = String(created.rows[0].id);
    res.status(201).json({ user: publicUser(created.rows[0]) });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Email sudah terdaftar." });
    next(e);
  }
});

app.post("/api/auth/login", authLimiter, async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Email atau kata sandi salah." });
    }
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = String(user.id);
      pool.query("UPDATE users SET last_seen_at = NOW() WHERE id = $1", [user.id]).catch(console.error);
      res.json({ user: publicUser(user) });
    });
  } catch (e) { next(e); }
});

app.post("/api/auth/logout", (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie("nusa.sid", { httpOnly: true, sameSite: "lax", secure: process.env.COOKIE_SECURE === "true" });
    res.json({ ok: true });
  });
});

app.get("/api/chats", requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT c.id,c.title,c.created_at,c.updated_at, COUNT(m.id)::int AS message_count FROM chats c LEFT JOIN messages m ON m.chat_id=c.id WHERE c.user_id=$1 GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 100",
      [req.user.id]
    );
    res.json({ chats: result.rows });
  } catch (e) { next(e); }
});

app.post("/api/chats", requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query("INSERT INTO chats (user_id,title) VALUES ($1,$2) RETURNING id,title,created_at,updated_at", [req.user.id, "Chat baru"]);
    res.status(201).json({ chat: result.rows[0] });
  } catch (e) { next(e); }
});

app.get("/api/chats/:id/messages", requireAuth, async (req, res, next) => {
  try {
    if (!await ownsChat(req.params.id, req.user.id)) return res.status(404).json({ error: "Chat tidak ditemukan." });
    const result = await pool.query("SELECT id,role,content,created_at FROM messages WHERE chat_id=$1 ORDER BY id ASC LIMIT 300", [req.params.id]);
    res.json({ messages: result.rows });
  } catch (e) { next(e); }
});

app.delete("/api/chats/:id", requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query("DELETE FROM chats WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
    if (!result.rowCount) return res.status(404).json({ error: "Chat tidak ditemukan." });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post("/api/chats/:id/messages", requireAuth, chatLimiter, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const chatId = req.params.id;
    const text = String(req.body?.message || "").trim();
    if (!text || text.length > 8000) return res.status(400).json({ error: "Pesan harus berisi 1–8000 karakter." });
    if (!await ownsChat(chatId, req.user.id)) return res.status(404).json({ error: "Chat tidak ditemukan." });
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "OPENAI_API_KEY belum diatur di environment server." });

    const previous = await pool.query(
      "SELECT role,content FROM messages WHERE chat_id=$1 ORDER BY id DESC LIMIT 20", [chatId]
    );
    const context = previous.rows.reverse().map((m) => ({ role: m.role, content: m.content }));
    await client.query("BEGIN");
    await client.query("INSERT INTO messages (chat_id,role,content) VALUES ($1,'user',$2)", [chatId, text]);
    await client.query("UPDATE chats SET title=CASE WHEN title='Chat baru' THEN $2 ELSE title END, updated_at=NOW() WHERE id=$1", [chatId, cleanTitle(text)]);
    await client.query("COMMIT");

    try {
      const response = await openai.responses.create({
        model: MODEL,
        instructions: "Kamu adalah Nusa AI, asisten berbahasa ramah dan jelas. Jawab dalam bahasa pengguna. Gunakan Markdown untuk judul, daftar, tabel, dan blok kode bila bermanfaat. Jangan mengaku memiliki kemampuan yang tidak tersedia.",
        input: [...context, { role: "user", content: text }]
      });
      const answer = String(response.output_text || "").trim() || "Maaf, belum ada jawaban. Coba lagi.";
      const saved = await pool.query(
        "INSERT INTO messages (chat_id,role,content) VALUES ($1,'assistant',$2) RETURNING id,role,content,created_at",
        [chatId, answer]
      );
      await pool.query("UPDATE chats SET updated_at=NOW() WHERE id=$1", [chatId]);
      res.json({ message: saved.rows[0] });
    } catch (apiError) {
      console.error("OpenAI API error:", apiError.status || apiError.message);
      res.status(502).json({ error: "Layanan AI gagal menjawab. Periksa konfigurasi API dan saldo/limit akun, lalu coba lagi." });
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    next(e);
  } finally { client.release(); }
});

app.get("/api/admin/overview", requireAuth, requireAdmin, adminLimiter, async (_req, res, next) => {
  try {
    const [users, chats, messages, recent] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS count FROM users"),
      pool.query("SELECT COUNT(*)::int AS count FROM chats"),
      pool.query("SELECT COUNT(*)::int AS count FROM messages"),
      pool.query("SELECT id,name,email,role,created_at,last_seen_at FROM users ORDER BY created_at DESC LIMIT 100")
    ]);
    res.json({ stats: { users: users.rows[0].count, chats: chats.rows[0].count, messages: messages.rows[0].count }, users: recent.rows });
  } catch (e) { next(e); }
});

app.patch("/api/admin/users/:id/role", requireAuth, requireAdmin, adminLimiter, async (req, res, next) => {
  try {
    const role = req.body?.role;
    if (!["user", "admin"].includes(role)) return res.status(400).json({ error: "Role tidak valid." });
    if (String(req.user.id) === String(req.params.id) && role !== "admin") return res.status(400).json({ error: "Kamu tidak bisa menurunkan role akun sendiri." });
    const result = await pool.query("UPDATE users SET role=$1 WHERE id=$2 RETURNING id,name,email,role,created_at,last_seen_at", [role, req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "Pengguna tidak ditemukan." });
    res.json({ user: result.rows[0] });
  } catch (e) { next(e); }
});

app.delete("/api/admin/users/:id", requireAuth, requireAdmin, adminLimiter, async (req, res, next) => {
  try {
    if (String(req.user.id) === String(req.params.id)) return res.status(400).json({ error: "Kamu tidak bisa menghapus akun sendiri." });
    const result = await pool.query("DELETE FROM users WHERE id=$1 RETURNING id", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "Pengguna tidak ditemukan." });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.use("/api", (_req, res) => res.status(404).json({ error: "Endpoint tidak ditemukan." }));
app.use((err, _req, res, _next) => {
  console.error("Server error:", err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: "Terjadi kesalahan server." });
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`Nusa AI berjalan di port ${PORT}`));
}).catch((error) => {
  console.error("Database gagal disiapkan:", error);
  process.exit(1);
});
