function getQuery(name) {
  const url = new URL(window.location.href);
  return url.searchParams.get(name);
}

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const chatId = getQuery("chatId");
document.getElementById("chatId").textContent = chatId || "-";

async function refresh() {
  if (!chatId) return;
  const res = await fetch(`/api/room?chatId=${encodeURIComponent(chatId)}`);
  const data = await res.json();
  if (!data.ok) {
    document.getElementById("status").textContent = "未找到房间（先在群里 /newgame）";
    document.getElementById("round").textContent = "-";
    document.getElementById("players").innerHTML = "";
    return;
  }
  const room = data.room;
  document.getElementById("status").textContent = room.status;
  document.getElementById("round").textContent = String(room.round || 0);
  const root = document.getElementById("players");
  root.innerHTML = "";
  for (const p of room.players) {
    const el = document.createElement("div");
    el.className = "player";
    el.innerHTML = `<div>${escapeHtml(p.name)}</div><div class="pill ${p.alive ? "alive" : "dead"}">${
      p.alive ? "存活" : "出局"
    }</div>`;
    root.appendChild(el);
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

document.getElementById("refresh").addEventListener("click", refresh);
document.getElementById("close").addEventListener("click", () => {
  if (tg) tg.close();
  else window.close();
});

refresh();

