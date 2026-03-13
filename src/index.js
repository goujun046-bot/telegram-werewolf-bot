import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Telegraf, Markup } from "telegraf";
import { HttpsProxyAgent } from "https-proxy-agent";
import {
  createInitialRoom,
  isGameOver,
  listPlayers,
  pickRoles,
  tallyVotes
} from "./game.js";

const BOT_TOKEN = "8789482336:AAHJtJDx5_aqOnf2dkALHfETP1axMc56Ma0";
if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN. Create a .env file based on .env.example.");
  process.exit(1);
}

const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/$/, "");
const PORT = Number(process.env.PORT || 3000);

const proxyUrl =
  (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || "").trim();
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

const bot = new Telegraf(BOT_TOKEN, {
  telegram: agent ? { agent } : undefined
});
const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");

app.use(express.json());
app.use(express.static(publicDir));

// In-memory rooms (per chat)
const rooms = new Map(); // chatId -> room

function getRoom(chatId) {
  if (!rooms.has(chatId)) rooms.set(chatId, createInitialRoom(chatId));
  return rooms.get(chatId);
}

function displayName(from) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  return name || from.username || String(from.id);
}

function mustBeGroup(ctx) {
  const t = ctx.chat?.type;
  return t === "group" || t === "supergroup";
}

function webAppUrl(chatId) {
  // Telegram WebApp needs https on the public internet.
  // For local dev, use ngrok/cloudflared and put it into PUBLIC_URL.
  const base = PUBLIC_URL || "http://localhost:" + PORT;
  return `${base}/?chatId=${encodeURIComponent(chatId)}`;
}

async function safeDm(botCtx, userId, text) {
  try {
    await botCtx.telegram.sendMessage(userId, text);
    return true;
  } catch {
    return false;
  }
}

bot.start(async (ctx) => {
  const text =
    "狼人杀小助手（简化版 1.0）\n\n" +
    "群里可用命令：\n" +
    "- /newgame 创建新局\n" +
    "- /join 加入\n" +
    "- /startgame 开始（会私聊发身份）\n" +
    "- /vote 发起投票\n" +
    "- /end 结束并清空\n\n" +
    "提示：身份需要私聊发送，请先点我头像进入私聊发一次 /start。";
  await ctx.reply(text);
});

bot.command("newgame", async (ctx) => {
  if (!mustBeGroup(ctx)) return ctx.reply("请在群里使用 /newgame。");
  const room = createInitialRoom(ctx.chat.id);
  room.hostId = ctx.from.id;
  rooms.set(ctx.chat.id, room);
  await ctx.reply(
    `已创建新局。房主：${displayName(ctx.from)}\n发送 /join 加入，人数够了房主发 /startgame 开始。`
  );
});

bot.command("join", async (ctx) => {
  if (!mustBeGroup(ctx)) return ctx.reply("请在群里使用 /join。");
  const room = getRoom(ctx.chat.id);
  if (room.status !== "lobby") return ctx.reply("本局已开始或已结束，先 /end 或重新 /newgame。");
  const p = {
    id: ctx.from.id,
    username: ctx.from.username || "",
    name: displayName(ctx.from)
  };
  room.players.set(p.id, p);
  await ctx.reply(`加入成功：${p.name}\n当前人数：${room.players.size}\n玩家：${listPlayers(room).join("、")}`);
});

bot.command("startgame", async (ctx) => {
  if (!mustBeGroup(ctx)) return ctx.reply("请在群里使用 /startgame。");
  const room = getRoom(ctx.chat.id);
  if (room.hostId && ctx.from.id !== room.hostId) {
    return ctx.reply("只有房主可以开始。");
  }
  if (room.status !== "lobby") return ctx.reply("本局已开始或已结束。");
  if (room.players.size < 4) return ctx.reply("至少需要 4 人才能开始。");

  room.roles = pickRoles(room.players.keys());
  room.alive = new Set(room.players.keys());
  room.status = "running";
  room.round = 1;
  room.votes.clear();
  room.nightKillTarget = null;

  // DM roles
  const failed = [];
  for (const uid of room.players.keys()) {
    const role = room.roles.get(uid);
    const ok = await safeDm(ctx, uid, `你的身份：${role === "werewolf" ? "🐺 狼人" : "👤 平民"}\n（请不要在群里公开）`);
    if (!ok) failed.push(uid);
  }
  if (failed.length) {
    await ctx.reply(
      "有玩家无法收到私聊身份（可能没先私聊机器人 /start）：\n" +
        failed.map((uid) => room.players.get(uid)?.name || uid).join("、") +
        "\n他们需要先私聊机器人发一次 /start，然后房主 /end 再 /newgame 重开。"
    );
    room.status = "lobby";
    room.roles.clear();
    room.alive.clear();
    return;
  }

  await ctx.reply(
    `游戏开始！第 ${room.round} 回合。\n` +
      `白天先讨论，然后房主或任何人发送 /vote 发起投票。`
  );
});

bot.command("vote", async (ctx) => {
  if (!mustBeGroup(ctx)) return ctx.reply("请在群里使用 /vote。");
  const room = getRoom(ctx.chat.id);
  if (room.status !== "running") return ctx.reply("当前没有进行中的游戏。");

  const alivePlayers = [...room.alive].map((uid) => room.players.get(uid)).filter(Boolean);
  if (alivePlayers.length < 2) return ctx.reply("存活人数不足。");

  const buttons = alivePlayers.map((p) => [Markup.button.callback(p.name, `vote:${ctx.chat.id}:${p.id}`)]);
  await ctx.reply("开始投票：点击你要投的玩家（可重复点击修改）。", Markup.inlineKeyboard(buttons));
});

bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery?.data || "";
  if (!data.startsWith("vote:")) return ctx.answerCbQuery();

  const [, chatIdStr, targetIdStr] = data.split(":");
  const chatId = Number(chatIdStr);
  const targetId = Number(targetIdStr);
  const room = rooms.get(chatId);
  if (!room || room.status !== "running") {
    await ctx.answerCbQuery("这局已结束或不存在。");
    return;
  }
  if (!room.alive.has(ctx.from.id)) {
    await ctx.answerCbQuery("你已出局，不能投票。");
    return;
  }
  if (!room.alive.has(targetId)) {
    await ctx.answerCbQuery("对方已出局。");
    return;
  }

  room.votes.set(ctx.from.id, targetId);
  await ctx.answerCbQuery("已记录你的投票。");
});

bot.command("tally", async (ctx) => {
  if (!mustBeGroup(ctx)) return ctx.reply("请在群里使用 /tally。");
  const room = getRoom(ctx.chat.id);
  if (room.status !== "running") return ctx.reply("当前没有进行中的游戏。");

  const res = tallyVotes(room);
  if (!res) return ctx.reply("还没有任何投票。");

  const targetName = room.players.get(res.targetId)?.name || String(res.targetId);
  room.alive.delete(res.targetId);
  room.votes.clear();

  const role = room.roles.get(res.targetId);
  await ctx.reply(`投票结果：${targetName} 出局（身份：${role === "werewolf" ? "🐺 狼人" : "👤 平民"}）`);

  const over = isGameOver(room);
  if (over.over) {
    room.status = "ended";
    const url = webAppUrl(ctx.chat.id);
    await ctx.reply(
      `游戏结束！胜利方：${over.winner === "villagers" ? "👤 平民" : "🐺 狼人"}\n` +
        `点击查看小程序：${url}`
    );
    return;
  }

  room.round += 1;
  await ctx.reply(`进入第 ${room.round} 回合。需要投票时发送 /vote，然后用 /tally 结算投票。`);
});

bot.command("end", async (ctx) => {
  if (!mustBeGroup(ctx)) return ctx.reply("请在群里使用 /end。");
  rooms.delete(ctx.chat.id);
  await ctx.reply("已结束并清空本群游戏数据。");
});

bot.command("miniapp", async (ctx) => {
  if (!mustBeGroup(ctx)) return ctx.reply("请在群里使用 /miniapp。");
  const url = webAppUrl(ctx.chat.id);
  await ctx.reply(
    "打开狼人杀小程序（WebApp）。\n提示：必须是公网 https 才能在 Telegram 内正常打开。",
    Markup.inlineKeyboard([Markup.button.webApp("打开小程序", url)])
  );
});

app.get("/api/room", (req, res) => {
  const chatId = Number(req.query.chatId);
  const room = rooms.get(chatId);
  if (!room) return res.json({ ok: false, error: "room_not_found" });
  const players = [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    alive: room.alive.has(p.id)
  }));
  res.json({
    ok: true,
    room: {
      chatId: room.chatId,
      status: room.status,
      round: room.round,
      players
    }
  });
});

app.listen(PORT, () => {
  console.log(`WebApp server on http://localhost:${PORT}`);
  if (!PUBLIC_URL) console.log("Tip: set PUBLIC_URL to your public https URL for Telegram WebApp buttons.");
});

bot.launch().then(() => console.log("Bot started (long polling)."));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));


