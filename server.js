
import express from "express";
import session from "express-session";
import pg from "pg";
import bcrypt from "bcryptjs";
import OpenAI from "openai";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET belum diatur.");
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL belum diatur.");
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);

const ai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1"
});

const MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(40) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS chats (
      id UUID PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'Chat baru',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Silakan login terlebih dahulu." });
  }
  next();
}

function cleanTitle(text) {
  return text.trim().replace(/\s+/g, " ").slice(0, 60) || "Chat baru";
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, app: "Nusa AI" });
});

app.post("/api/register", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    if (!/^[a-zA-Z0-9_]{3,40}$/.test(username)) {
      return res.status(400).json({
        error: "Username harus 3–40 karakter, hanya huruf, angka, dan _."
      });
    }

    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({
        error: "Password harus 8–128 karakter."
      });
    }

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, $2)
       RETURNING id, username, is_admin`,
      [username, hash]
    );

    req.session.user = result.rows[0];
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Username sudah digunakan." });
    }
    console.error("Register error:", err.message);
    res.status(500).json({ error: "Registrasi gagal." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    const result = await pool.query(
      `SELECT id, username, password_hash, is_admin
       FROM users WHERE username = $1`,
      [username]
    );

    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Username atau password salah." });
    }

    req.session.regenerate((err) => {
      if (err) {
        return res.status(500).json({ error: "Gagal membuat sesi login." });
      }

      const { password_hash, ...safeUser } = user;
      req.session.user = safeUser;
      res.json({ user: safeUser });
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Login gagal." });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "Gagal logout." });
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

app.get("/api/me", (req, res) => {
  res.json({ user: req.session.user || null });
});

app.get("/api/chats", requireLogin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, created_at, updated_at
       FROM chats WHERE user_id = $1
       ORDER BY updated_at DESC`,
      [req.session.user.id]
    );
    res.json({ chats: result.rows });
  } catch (err) {
    console.error("Chats error:", err.message);
    res.status(500).json({ error: "Gagal memuat riwayat chat." });
  }
});

app.post("/api/chats", requireLogin, async (req, res) => {
  try {
    const id = crypto.randomUUID();
    const result = await pool.query(
      `INSERT INTO chats (id, user_id, title)
       VALUES ($1, $2, 'Chat baru')
       RETURNING id, title, created_at, updated_at`,
      [id, req.session.user.id]
    );
    res.status(201).json({ chat: result.rows[0] });
  } catch (err) {
    console.error("Create chat error:", err.message);
    res.status(500).json({ error: "Gagal membuat chat." });
  }
});

app.get("/api/chats/:id/messages", requireLogin, async (req, res) => {
  try {
    const chat = await pool.query(
      "SELECT id FROM chats WHERE id = $1 AND user_id = $2",
      [req.params.id, req.session.user.id]
    );

    if (!chat.rowCount) {
      return res.status(404).json({ error: "Chat tidak ditemukan." });
    }

    const result = await pool.query(
      `SELECT id, role, content, created_at
       FROM messages WHERE chat_id = $1 ORDER BY id ASC`,
      [req.params.id]
    );
    res.json({ messages: result.rows });
  } catch (err) {
    console.error("Messages error:", err.message);
    res.status(500).json({ error: "Gagal memuat pesan." });
  }
});

app.delete("/api/chats/:id", requireLogin, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM chats WHERE id = $1 AND user_id = $2",
      [req.params.id, req.session.user.id]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: "Chat tidak ditemukan." });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete chat error:", err.message);
    res.status(500).json({ error: "Gagal menghapus chat." });
  }
});

app.post("/api/chat", requireLogin, async (req, res) => {
  const text = String(req.body.message || "").trim();
  const chatId = String(req.body.chatId || "");

  if (!text) {
    return res.status(400).json({ error: "Pesan tidak boleh kosong." });
  }

  if (text.length > 12000) {
    return res.status(400).json({ error: "Pesan maksimal 12.000 karakter." });
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(503).json({
      error: "OPENROUTER_API_KEY belum diatur di server."
    });
  }

  const client = await pool.connect();

  try {
    const ownedChat = await client.query(
      "SELECT id FROM chats WHERE id = $1 AND user_id = $2",
      [chatId, req.session.user.id]
    );

    if (!ownedChat.rowCount) {
      return res.status(404).json({ error: "Chat tidak ditemukan." });
    }

    const previous = await client.query(
      `SELECT role, content FROM messages
       WHERE chat_id = $1 ORDER BY id DESC LIMIT 20`,
      [chatId]
    );

    const context = previous.rows.reverse().map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content
    }));

    await client.query("BEGIN");
    await client.query(
      "INSERT INTO messages (chat_id, role, content) VALUES ($1, 'user', $2)",
      [chatId, text]
    );
    await client.query(
      `UPDATE chats
       SET title = CASE WHEN title = 'Chat baru' THEN $2 ELSE title END,
           updated_at = NOW()
       WHERE id = $1`,
      [chatId, cleanTitle(text)]
    );
    await client.query("COMMIT");

    try {
      const response = await ai.chat.completions.create({
        model: MODEL,
        messages: [
          {
            role: "system",
            content:
              "Kamu adalah Nusa AI, asisten berbahasa Indonesia yang ramah, cerdas, dan jelas. Jawab sesuai bahasa pengguna. Gunakan Markdown jika membantu. Jelaskan langkah demi langkah bila diperlukan. Jangan mengarang fakta dan akui bila tidak yakin."
          },
          ...context,
          { role: "user", content: text }
        ]
      });

      const answer = String(
        response.choices?.[0]?.message?.content || ""
      ).trim() || "Maaf, belum ada jawaban. Coba lagi.";

      const saved = await pool.query(
        `INSERT INTO messages (chat_id, role, content)
         VALUES ($1, 'assistant', $2)
         RETURNING id, role, content, created_at`,
        [chatId, answer]
      );

      await pool.query(
        "UPDATE chats SET updated_at = NOW() WHERE id = $1",
        [chatId]
      );

      res.json({ message: saved.rows[0] });
    } catch (apiError) {
      console.error(
        "OpenRouter error:",
        apiError.status || "",
        apiError.message
      );
      res.status(502).json({
        error: "AI gagal menjawab. Periksa log server dan batas penggunaan model gratis."
      });
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Chat error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Terjadi kesalahan saat memproses chat." });
    }
  } finally {
    client.release();
  }
});

// Admin: daftar pengguna hanya untuk akun yang sudah ditandai is_admin.
app.get("/api/admin/users", requireLogin, async (req, res) => {
  if (!req.session.user.is_admin) {
    return res.status(403).json({ error: "Akses admin ditolak." });
  }

  try {
    const result = await pool.query(
      `SELECT id, username, is_admin, created_at
       FROM users ORDER BY created_at DESC`
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error("Admin error:", err.message);
    res.status(500).json({ error: "Gagal memuat pengguna." });
  }
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Endpoint tidak ditemukan." });
  }
  res.sendFile(path.join(__dirname, "public", "index.html"), (err) => {
    if (err) next(err);
  });
});

initDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Nusa AI berjalan pada port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Database initialization failed:", err.message);
    process.exit(1);
  });
