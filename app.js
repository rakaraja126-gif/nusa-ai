const $ = (s) => document.querySelector(s);
const authScreen = $("#auth-screen"), app = $("#app"), authForm = $("#auth-form");
const authTitle = $("#auth-title"), authSubtitle = $("#auth-subtitle"), authSubmit = $("#auth-submit");
const authSwitch = $("#auth-switch"), authSwitchCopy = $("#auth-switch-copy");
const nameField = $("#name-field"), adminTokenField = $("#admin-token-field");
const authError = $("#auth-error"), messagesEl = $("#messages"), welcome = $("#welcome");
const input = $("#message-input"), sendButton = $("#send-button"), chatList = $("#chat-list");
let user = null, chats = [], activeChatId = null, busy = false, authMode = "login";

function showError(el, message) { el.textContent = message; el.classList.toggle("hidden", !message); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c])); }
function renderMarkdown(text) {
  // Sanitasi HTML dari hasil Markdown sebelum dimasukkan ke DOM.
  if (window.marked && window.DOMPurify) {
    return DOMPurify.sanitize(marked.parse(String(text), { breaks: true }), { USE_PROFILES: { html: true } });
  }
  return `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
}
function addMessage(role, content, opts = {}) {
  const item = document.createElement("div");
  item.className = `message ${role}${opts.typing ? " typing" : ""}`;
  const avatar = document.createElement("div"); avatar.className = "avatar"; avatar.textContent = role === "user" ? (user?.name?.[0] || "K").toUpperCase() : "✦";
  const body = document.createElement("div"); body.className = "message-body";
  if (role === "assistant" && !opts.typing) body.innerHTML = renderMarkdown(content);
  else body.textContent = content;
  item.append(avatar, body); messagesEl.append(item); welcome.classList.add("hidden");
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  return { item, body };
}
function clearMessages() { messagesEl.replaceChildren(); welcome.classList.remove("hidden"); }
function showAuth(mode = "login") {
  authMode = mode; authScreen.classList.remove("hidden"); app.classList.add("hidden");
  const register = mode === "register";
  authTitle.textContent = register ? "Buat akun baru" : "Selamat datang";
  authSubtitle.textContent = register ? "Daftar untuk menyimpan riwayat chat kamu." : "Masuk untuk melanjutkan percakapanmu.";
  authSubmit.textContent = register ? "Daftar akun" : "Masuk";
  authSwitchCopy.textContent = register ? "Sudah punya akun?" : "Belum punya akun?";
  authSwitch.textContent = register ? "Masuk" : "Daftar";
  nameField.classList.toggle("hidden", !register);
  adminTokenField.classList.toggle("hidden", !register);
  $("#auth-password").autocomplete = register ? "new-password" : "current-password";
  showError(authError, "");
}
async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Permintaan gagal.");
  return data;
}
async function loadChats() {
  const data = await api("/api/chats"); chats = data.chats;
  chatList.replaceChildren();
  if (!chats.length) {
    const empty = document.createElement("p"); empty.className = "muted"; empty.style.padding = "0 10px"; empty.textContent = "Belum ada percakapan."; chatList.append(empty);
    return;
  }
  for (const chat of chats) {
    const row = document.createElement("div"); row.className = "chat-row";
    const select = document.createElement("button"); select.className = `chat-select${String(chat.id) === String(activeChatId) ? " active" : ""}`; select.textContent = chat.title || "Chat baru"; select.title = chat.title;
    select.addEventListener("click", () => openChat(String(chat.id)));
    const del = document.createElement("button"); del.className = "chat-delete"; del.textContent = "×"; del.title = "Hapus chat";
    del.addEventListener("click", async (e) => { e.stopPropagation(); if (!confirm("Hapus percakapan ini?")) return;
      try { await api(`/api/chats/${chat.id}`, { method: "DELETE" }); if (String(activeChatId) === String(chat.id)) { activeChatId = null; clearMessages(); } await loadChats(); }
      catch (err) { alert(err.message); }
    });
    row.append(select, del); chatList.append(row);
  }
}
async function openChat(id) {
  activeChatId = String(id); clearMessages();
  const data = await api(`/api/chats/${id}/messages`);
  for (const m of data.messages) addMessage(m.role, m.content);
  await loadChats();
  $("#sidebar")?.classList.remove("mobile-open");
  window.scrollTo({ top: document.body.scrollHeight });
}
async function newChat() {
  try {
    const data = await api("/api/chats", { method: "POST", body: JSON.stringify({}) });
    activeChatId = String(data.chat.id); clearMessages(); input.focus(); await loadChats();
    $(".sidebar").classList.remove("mobile-open");
  } catch (e) { alert(e.message); }
}
async function enterApp(nextUser) {
  user = nextUser; authScreen.classList.add("hidden"); app.classList.remove("hidden");
  $("#user-name").textContent = user.name; $("#user-role").textContent = user.role;
  $("#admin-open").classList.toggle("hidden", user.role !== "admin");
  await loadChats();
  if (chats.length) await openChat(String(chats[0].id)); else { activeChatId = null; clearMessages(); }
}
authSwitch.addEventListener("click", () => showAuth(authMode === "login" ? "register" : "login"));
authForm.addEventListener("submit", async (event) => {
  event.preventDefault(); showError(authError, ""); authSubmit.disabled = true;
  try {
    const body = { email: $("#auth-email").value.trim(), password: $("#auth-password").value };
    if (authMode === "register") {
      body.name = $("#auth-name").value.trim();
      body.adminToken = $("#auth-admin-token").value;
    }
    const data = await api(`/api/auth/${authMode}`, { method: "POST", body: JSON.stringify(body) });
    authForm.reset(); await enterApp(data.user);
  } catch (e) { showError(authError, e.message); }
  finally { authSubmit.disabled = false; }
});
$("#logout").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST", body: JSON.stringify({}) }); } finally {
    user = null; chats = []; activeChatId = null; clearMessages(); showAuth("login");
  }
});
$("#new-chat").addEventListener("click", newChat);
$("#mobile-new-chat").addEventListener("click", newChat);
$("#mobile-sidebar").addEventListener("click", () => $(".sidebar").classList.toggle("mobile-open"));

async function sendMessage(text) {
  text = text.trim(); if (!text || busy) return;
  if (!activeChatId) {
    const created = await api("/api/chats", { method: "POST", body: JSON.stringify({}) });
    activeChatId = String(created.chat.id);
  }
  busy = true; sendButton.disabled = true; input.value = ""; input.style.height = "auto";
  addMessage("user", text);
  const pending = addMessage("assistant", "Sedang berpikir…", { typing: true });
  try {
    const data = await api(`/api/chats/${activeChatId}/messages`, { method: "POST", body: JSON.stringify({ message: text }) });
    pending.item.classList.remove("typing"); pending.body.innerHTML = renderMarkdown(data.message.content);
  } catch (e) {
    pending.item.remove(); addMessage("assistant", `Maaf, terjadi masalah: ${e.message}`);
  } finally {
    busy = false; sendButton.disabled = false; input.focus();
    await loadChats().catch(() => {});
  }
}
$("#chat-form").addEventListener("submit", (e) => { e.preventDefault(); sendMessage(input.value).catch(err => alert(err.message)); });
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; });
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#chat-form").requestSubmit(); } });
document.querySelectorAll(".suggestion").forEach(b => b.addEventListener("click", () => sendMessage(b.dataset.prompt || "")));

const adminModal = $("#admin-modal");
$("#admin-close").addEventListener("click", () => adminModal.classList.add("hidden"));
$("#admin-open").addEventListener("click", async () => {
  adminModal.classList.remove("hidden"); showError($("#admin-error"), "");
  try {
    const data = await api("/api/admin/overview");
    $("#admin-stats").innerHTML = [["Pengguna",data.stats.users],["Percakapan",data.stats.chats],["Pesan",data.stats.messages]].map(([label,value]) => `<div class="stat"><small>${label}</small><b>${value}</b></div>`).join("");
    const tbody = $("#admin-users"); tbody.replaceChildren();
    for (const u of data.users) {
      const tr = document.createElement("tr");
      const joined = u.created_at ? new Date(u.created_at).toLocaleDateString("id-ID") : "—";
      const userCell = document.createElement("td"); userCell.textContent = `${u.name} (${u.email})`;
      const roleCell = document.createElement("td");
      const role = document.createElement("select"); role.className = "role-select"; role.innerHTML = `<option value="user">user</option><option value="admin">admin</option>`; role.value = u.role;
      role.addEventListener("change", async () => {
        try { await api(`/api/admin/users/${u.id}/role`, { method: "PATCH", body: JSON.stringify({ role: role.value }) }); }
        catch (e) { alert(e.message); role.value = u.role; }
      });
      roleCell.append(role);
      const dateCell = document.createElement("td"); dateCell.textContent = joined;
      const actionCell = document.createElement("td");
      const remove = document.createElement("button"); remove.className = "danger-btn"; remove.textContent = "Hapus";
      remove.disabled = String(u.id) === String(user.id);
      remove.addEventListener("click", async () => {
        if (!confirm(`Hapus akun ${u.email} beserta seluruh riwayatnya?`)) return;
        try { await api(`/api/admin/users/${u.id}`, { method: "DELETE" }); tr.remove(); }
        catch (e) { showError($("#admin-error"), e.message); }
      });
      actionCell.append(remove); tr.append(userCell, roleCell, dateCell, actionCell); tbody.append(tr);
    }
  } catch (e) { showError($("#admin-error"), e.message); }
});
adminModal.addEventListener("click", e => { if (e.target === adminModal) adminModal.classList.add("hidden"); });

(async function init() {
  try {
    const data = await api("/api/me");
    if (data.user) await enterApp(data.user); else showAuth("login");
  } catch { showAuth("login"); }
})();
