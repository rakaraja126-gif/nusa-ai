# Nusa AI Pro

Website AI chat full-stack: login/registrasi, riwayat chat tersimpan di PostgreSQL, dashboard admin, rendering Markdown yang disanitasi, dan OpenAI Responses API.

## Fitur
- Email + password, password hash menggunakan bcrypt.
- Session cookie HttpOnly, SameSite=Lax, disimpan di PostgreSQL.
- Setiap pengguna hanya bisa melihat/menghapus chat miliknya.
- Riwayat percakapan dan pesan disimpan di database.
- Admin dapat melihat statistik, mengubah role, dan menghapus akun.
- Rate limit dasar untuk login, chat, dan admin.
- Markdown untuk daftar, tabel, tautan, dan kode; HTML keluaran disanitasi dengan DOMPurify.
- API key hanya ada di environment server.

## Jalankan lokal
Persyaratan: Node.js 20+, PostgreSQL.

1. Buat database PostgreSQL lokal, misalnya `nusa_ai`.
2. Salin `.env.example` menjadi `.env` lalu isi `DATABASE_URL`, `SESSION_SECRET`, `OPENAI_API_KEY`, `ADMIN_EMAIL`, dan `ADMIN_BOOTSTRAP_TOKEN`.
3. Gunakan secret acak panjang untuk `SESSION_SECRET` dan token admin (setidaknya 24 karakter untuk token admin).
4. Jalankan `npm install`, lalu `npm start`.
5. Buka `http://localhost:3000`.
6. Daftar akun dengan email yang sama dengan `ADMIN_EMAIL` dan isi `ADMIN_BOOTSTRAP_TOKEN` untuk membuat admin pertama. Token hanya bekerja untuk admin pertama dan harus dijaga rahasia. Setelah berhasil, hapus token dari environment jika tidak diperlukan.

## Deploy ke Render
1. Buat repository Git dan unggah kode ini. Jangan pernah commit `.env`.
2. Di Render, buat PostgreSQL database. Salin internal connection string ke environment `DATABASE_URL` pada web service.
3. Buat Web Service dari repository, runtime Node.
4. Build command: `npm install`; Start command: `npm start`.
5. Set environment variables:
   - `DATABASE_URL`: connection string database Render
   - `SESSION_SECRET`: secret acak minimal 32 karakter
   - `OPENAI_API_KEY`: API key OpenAI
   - `OPENAI_MODEL`: model yang tersedia untuk akun API kamu, default `gpt-4.1-mini`
   - `ADMIN_EMAIL`: email yang akan menjadi admin pertama
   - `ADMIN_BOOTSTRAP_TOKEN`: token rahasia acak minimal 24 karakter
   - `COOKIE_SECURE`: `true`
   - `NODE_ENV`: `production`
6. Deploy, buka URL Render, daftar menggunakan email admin + token bootstrap, lalu hapus token dari environment setelah admin berhasil dibuat.
7. Tes registrasi pengguna biasa, login, mengirim pesan, membuka kembali riwayat, dan dashboard admin.
8. Bagikan URL HTTPS Render kepada pengguna.

File `render.yaml` disediakan sebagai contoh konfigurasi Infrastructure as Code. Periksa kembali pilihan paket database/hosting dan biayanya sebelum deploy.

## Penting sebelum layanan publik
Ini starter project, bukan audit keamanan produksi. Sebelum dipromosikan secara luas:
- Tambahkan CAPTCHA / perlindungan bot, verifikasi email, reset password, kebijakan privasi, dan mekanisme penghapusan data.
- Tambahkan limit harian per akun, kuota token, alert biaya, dan proteksi penyalahgunaan API.
- Buat backup database dan uji pemulihan.
- Pertimbangkan CSRF protection yang lebih ketat, audit log admin, serta pembatasan jumlah akun/percakapan.
- Jangan bagikan token bootstrap admin atau API key. Jika bocor, rotasi segera.
- API OpenAI dapat menimbulkan biaya terpisah; website ini tidak menyediakan kredit API gratis.
