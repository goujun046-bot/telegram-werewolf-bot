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
  startGame,
  recordWolfVote,
  recordSeerCheck,
  recordWitchSave,
  recordWitchPoison,
  canResolveNight,
  resolveNight,
  resetNight,
  resetDay,
  startVoting,
  recordDayVote,
  tallyDayVotes,
  applyLynch
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

async function safeDm(botCtx, userId, text, extra = {}) {
  try {
    await botCtx.telegram.sendMessage(userId, text, extra);
    return true;
  } catch {
    return false;
  }
}

bot.start(async (ctx) => {
  const text =
    "狼人杀小助手（标准流程 1.0）\n\n" +
    "群里可用命令：\n" +
    "- /newgame 创建新局\n" +
    "- /join 加入\n" +
    "- /startgame 开始（私聊发身份，进入黑夜）\n" +
    "- /vote 白天发起投票（或平票重投）\n" +
    "- /tally 结算投票（处决/平票重投）\n" +
    "- /end 结束并清空\n\n" +
    "提示：身份/夜晚操作需要私聊发送，请先点我头像进入私聊发一次 /start。";
  await ctx.reply(text);
});

function roleName(role) {
  if (role === "werewolf") return "🐺 狼人";
  if (role === "seer") return "🔮 预言家";
  if (role === "witch") return "🧪 女巫";
  return "👤 平民";
}

function alivePlayers(room) {
  return [...room.alive].map((uid) => room.players.get(uid)).filter(Boolean);
}

function aliveButtons(room, prefix) {
  const btns = alivePlayers(room).map((p) => [Markup.button.callback(p.name, `${prefix}:${room.chatId}:${p.id}`)]);
  return Markup.inlineKeyboard(btns);
}

async function dmRoleAndHelp(ctx, room, uid) {
  const role = room.roles.get(uid);
  const name = roleName(role);
  const tips =
    role === "werewolf"
      ? "夜晚会收到“选择刀谁”的按钮（私聊操作）。"
      : role === "seer"
        ? "夜晚会收到“查验谁”的按钮（私聊操作）。"
        : role === "witch"
          ? "夜晚会收到“救/不救 + 毒/不毒”的按钮（私聊操作）。解药/毒药各一次。"
          : "白天参与投票即可。";
  return safeDm(ctx, uid, `你的身份：${name}\n${tips}\n（请不要在群里公开）`);
}

async function startNightFlow(ctx, room) {
  // Wolves: pick kill
  const wolves = [...room.alive].filter((uid) => room.roles.get(uid) === "werewolf");
  for (const wid of wolves) {
    await safeDm(ctx, wid, "🌙 黑夜：请选择你要击杀的玩家。", aliveButtons(room, "wolfkill"));
  }

  // Seer: check
  const seerId = [...room.alive].find((uid) => room.roles.get(uid) === "seer");
  if (seerId) {
    await safeDm(ctx, seerId, "🌙 黑夜：请选择你要查验的玩家。", aliveButtons(room, "seercheck"));
  }

  // Witch is prompted once when all wolves have voted (see callback).
}

async function promptWitch(ctx, room) {
  const witchId = [...room.alive].find((uid) => room.roles.get(uid) === "witch");
  if (!witchId) return;
  if (!room.night.wolvesAllVoted) return;
  if (room.night.witchPrompted) return;

  const wolfTarget = room.night.wolfTarget;
  const victimText =
    wolfTarget == null
      ? "狼人未刀人（平票）。"
      : `狼人选择击杀的是「${room.players.get(wolfTarget)?.name || "未知"}」。`;
  const canSave = !room.ability.witchAntidoteUsed;
  const canPoison = !room.ability.witchPoisonUsed;

  if (!canSave) recordWitchSave(room, false);
  if (!canPoison) {
    room.night.witchPoisonTarget = null;
    room.night.witchPoisonDecided = true;
  }

  const rows = [];
  if (canSave) {
    rows.push([
      Markup.button.callback("✅ 救", `witchsave:${room.chatId}:yes`),
      Markup.button.callback("❌ 不救", `witchsave:${room.chatId}:no`)
    ]);
  }
  if (canPoison) {
    rows.push([Markup.button.callback("🧪 选择毒谁", `witchpoisonpick:${room.chatId}`)]);
    rows.push([Markup.button.callback("跳过用毒", `witchpoisonskip:${room.chatId}`)]);
  }

  room.night.witchPrompted = true;

  if (rows.length === 0) {
    await safeDm(
      ctx,
      witchId,
      `🌙 黑夜：${victimText}\n解药和毒药均已使用过，无需操作。`
    );
    await maybeResolveNight(ctx, room);
    return;
  }

  await safeDm(
    ctx,
    witchId,
    `🌙 黑夜：${victimText}\n你要使用解药吗？（解药仅一次）\n你要使用毒药吗？（毒药仅一次）`,
    Markup.inlineKeyboard(rows)
  );
}

async function maybeResolveNight(ctx, room) {
  if (!canResolveNight(room)) return;
  const deaths = resolveNight(room);
  const names = deaths.map((uid) => room.players.get(uid)?.name || uid);
  await ctx.telegram.sendMessage(
    room.chatId,
    deaths.length === 0 ? "天亮了：昨晚是平安夜。" : `天亮了：昨晚死亡 ${deaths.length} 人：${names.join("、")}`
  );
  const over = isGameOver(room);
  if (over.over) {
    room.status = "ended";
    room.phase = "ended";
    const url = webAppUrl(room.chatId);
    await ctx.telegram.sendMessage(
      room.chatId,
      `游戏结束！胜利方：${over.winner === "villagers" ? "👤 好人阵营" : "🐺 狼人阵营"}\n` + `查看小程序：${url}`
    );
    return;
  }
  await ctx.telegram.sendMessage(room.chatId, "白天开始：自由讨论。需要投票时发送 /vote。");
}

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
  startGame(room);

  // DM roles
  const failed = [];
  for (const uid of room.players.keys()) {
    const ok = await dmRoleAndHelp(ctx, room, uid);
    if (!ok) failed.push(uid);
  }
  if (failed.length) {
    await ctx.reply(
      "有玩家无法收到私聊身份（可能没先私聊机器人 /start）：\n" +
        failed.map((uid) => room.players.get(uid)?.name || uid).join("、") +
        "\n他们需要先私聊机器人发一次 /start，然后房主 /end 再 /newgame 重开。"
    );
    room.status = "lobby";
    room.phase = "lobby";
    room.roles.clear();
    room.alive.clear();
    return;
  }

  await ctx.reply(`游戏开始！第 1 天黑夜降临。\n请注意查看私聊进行夜晚操作。`);
  await startNightFlow(ctx, room);
});

bot.command("vote", async (ctx) => {
  if (!mustBeGroup(ctx)) return ctx.reply("请在群里使用 /vote。");
  const room = getRoom(ctx.chat.id);
  if (room.status !== "running") return ctx.reply("当前没有进行中的游戏。");
  if (room.phase !== "day" && room.phase !== "voting") {
    return ctx.reply("现在不是白天投票阶段。请先完成夜晚行动。");
  }
  if (alivePlayers(room).length < 2) return ctx.reply("存活人数不足。");

  startVoting(room);
  const prefix = room.day.revote ? "dayrevote" : "dayvote";
  const keyboard =
    room.day.revote && room.day.revoteCandidates.length
      ? Markup.inlineKeyboard(
          room.day.revoteCandidates
            .map((uid) => room.players.get(uid))
            .filter(Boolean)
            .map((p) => [Markup.button.callback(p.name, `${prefix}:${ctx.chat.id}:${p.id}`)])
        )
      : aliveButtons(room, prefix);
  await ctx.reply(room.day.revote ? "平票重投：只能投给候选人。" : "开始投票：点击你要投的玩家（可重复点击修改）。", keyboard);
});

bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery?.data || "";
  const parts = data.split(":");
  const type = parts[0];

  // Common
  const chatId = Number(parts[1]);
  const room = rooms.get(chatId);
  if (!room || room.status !== "running") return ctx.answerCbQuery("这局已结束或不存在。");
  const me = ctx.from.id;

  // Wolf kill
  if (type === "wolfkill") {
    const targetId = Number(parts[2]);
    if (room.phase !== "night") return ctx.answerCbQuery("现在不是黑夜。");
    if (room.roles.get(me) !== "werewolf") return ctx.answerCbQuery("你不是狼人。");
    if (!room.alive.has(me)) return ctx.answerCbQuery("你已出局。");
    if (!room.alive.has(targetId)) return ctx.answerCbQuery("目标已出局。");
    recordWolfVote(room, me, targetId);
    const wolves = [...room.alive].filter((uid) => room.roles.get(uid) === "werewolf");
    if (wolves.length > 0 && room.night.wolfVotes.size >= wolves.length) {
      room.night.wolvesAllVoted = true;
      await promptWitch(ctx, room);
    }
    await ctx.answerCbQuery("已记录。");
    return;
  }

  // Seer check
  if (type === "seercheck") {
    const targetId = Number(parts[2]);
    if (room.phase !== "night") return ctx.answerCbQuery("现在不是黑夜。");
    if (room.roles.get(me) !== "seer") return ctx.answerCbQuery("你不是预言家。");
    if (!room.alive.has(me)) return ctx.answerCbQuery("你已出局。");
    if (!room.alive.has(targetId)) return ctx.answerCbQuery("目标已出局。");
    recordSeerCheck(room, targetId);
    const role = room.roles.get(targetId);
    await ctx.answerCbQuery("已查验。");
    await safeDm(ctx, me, `🔮 查验结果：「${room.players.get(targetId)?.name || targetId}」是 ${role === "werewolf" ? "🐺 狼人" : "👤 好人"}`);
    return;
  }

  // Witch save
  if (type === "witchsave") {
    const choice = parts[2]; // yes|no
    if (room.phase !== "night") return ctx.answerCbQuery("现在不是黑夜。");
    if (room.roles.get(me) !== "witch") return ctx.answerCbQuery("你不是女巫。");
    if (!room.alive.has(me)) return ctx.answerCbQuery("你已出局。");
    if (room.ability.witchAntidoteUsed) return ctx.answerCbQuery("解药已用完。");
    recordWitchSave(room, choice === "yes");
    await ctx.answerCbQuery("已记录。");
    const canPoison = !room.ability.witchPoisonUsed && !room.night.witchPoisonDecided;
    if (canPoison) {
      const poisonRows = alivePlayers(room).map((p) => [Markup.button.callback(p.name, `witchpoison:${room.chatId}:${p.id}`)]);
      poisonRows.push([Markup.button.callback("跳过用毒", `witchpoisonskip:${room.chatId}`)]);
      await safeDm(ctx, me, "🧪 请选择你要毒的玩家，或点击「跳过用毒」。", Markup.inlineKeyboard(poisonRows));
    } else {
      await maybeResolveNight(ctx, room);
    }
    return;
  }

  // Witch poison pick
  if (type === "witchpoisonpick") {
    if (room.phase !== "night") return ctx.answerCbQuery("现在不是黑夜。");
    if (room.roles.get(me) !== "witch") return ctx.answerCbQuery("你不是女巫。");
    if (!room.alive.has(me)) return ctx.answerCbQuery("你已出局。");
    if (room.ability.witchPoisonUsed) return ctx.answerCbQuery("毒药已用完。");
    await ctx.answerCbQuery("请选择要毒的玩家。");
    await safeDm(ctx, me, "🧪 请选择你要毒的玩家。", aliveButtons(room, "witchpoison"));
    return;
  }

  if (type === "witchpoisonskip") {
    if (room.phase !== "night") return ctx.answerCbQuery("现在不是黑夜。");
    if (room.roles.get(me) !== "witch") return ctx.answerCbQuery("你不是女巫。");
    if (!room.alive.has(me)) return ctx.answerCbQuery("你已出局。");
    room.night.witchPoisonTarget = null;
    room.night.witchPoisonDecided = true;
    await ctx.answerCbQuery("已跳过用毒。");
    await maybeResolveNight(ctx, room);
    return;
  }

  if (type === "witchpoison") {
    const targetId = Number(parts[2]);
    if (room.phase !== "night") return ctx.answerCbQuery("现在不是黑夜。");
    if (room.roles.get(me) !== "witch") return ctx.answerCbQuery("你不是女巫。");
    if (!room.alive.has(me)) return ctx.answerCbQuery("你已出局。");
    if (room.ability.witchPoisonUsed) return ctx.answerCbQuery("毒药已用完。");
    if (!room.alive.has(targetId)) return ctx.answerCbQuery("目标已出局。");
    recordWitchPoison(room, targetId);
    await ctx.answerCbQuery("已用毒。");
    await maybeResolveNight(ctx, room);
    return;
  }

  // Day vote / revote
  if (type === "dayvote" || type === "dayrevote") {
    const targetId = Number(parts[2]);
    if (room.phase !== "voting") return ctx.answerCbQuery("现在不是投票阶段。");
    if (!room.alive.has(me)) return ctx.answerCbQuery("你已出局，不能投票。");
    if (!room.alive.has(targetId)) return ctx.answerCbQuery("目标已出局。");
    recordDayVote(room, me, targetId);
    await ctx.answerCbQuery("已记录你的投票。");
    return;
  }

  return ctx.answerCbQuery();
});

bot.command("tally", async (ctx) => {
  if (!mustBeGroup(ctx)) return ctx.reply("请在群里使用 /tally。");
  const room = getRoom(ctx.chat.id);
  if (room.status !== "running") return ctx.reply("当前没有进行中的游戏。");
  if (room.phase !== "voting") return ctx.reply("现在不是投票结算阶段，先用 /vote 发起投票。");

  const res = tallyDayVotes(room);
  if (res.type === "no_votes") return ctx.reply("还没有任何投票。");

  if (res.type === "tie") {
    if (room.day.revote) {
      room.phase = "night";
      room.round += 1;
      room.day.revote = false;
      room.day.revoteCandidates = [];
      resetNight(room);
      resetDay(room);
      await ctx.reply("再次平票：本轮无人被处决。进入黑夜，请注意查看私聊。");
      await startNightFlow(ctx, room);
      return;
    }
    room.day.revote = true;
    room.day.revoteCandidates = res.candidates;
    room.phase = "day";
    const names = res.candidates.map((uid) => room.players.get(uid)?.name || uid).join("、");
    await ctx.reply(`平票（${res.count} 票）：${names}\n请重投：发送 /vote（只能投这几位）。`);
    return;
  }

  const targetName = room.players.get(res.targetId)?.name || String(res.targetId);
  const role = room.roles.get(res.targetId);
  applyLynch(room, res.targetId);
  await ctx.reply(`处决结果：${targetName} 出局（身份：${roleName(role)}）\n进入黑夜，请注意查看私聊。`);

  const over = isGameOver(room);
  if (over.over) {
    room.status = "ended";
    room.phase = "ended";
    const url = webAppUrl(ctx.chat.id);
    await ctx.reply(
      `游戏结束！胜利方：${over.winner === "villagers" ? "👤 好人阵营" : "🐺 狼人阵营"}\n` + `查看小程序：${url}`
    );
    return;
  }

  await startNightFlow(ctx, room);
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
      phase: room.phase,
      round: room.round,
      lastPublicLog: room.lastPublicLog,
      lastDeaths: room.lastDeaths,
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

