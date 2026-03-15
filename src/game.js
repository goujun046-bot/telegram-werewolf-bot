export function createInitialRoom(chatId) {
  return {
    chatId,
    status: "lobby", // lobby | running | ended
    hostId: null,
    players: new Map(), // userId -> { id, username, name }
    roles: new Map(), // userId -> role
    alive: new Set(), // userIds
    round: 0,
    phase: "lobby", // lobby | night | day | voting | ended
    lastPublicLog: "",
    lastDeaths: [],
    night: {
      wolfVotes: new Map(), // wolfId -> targetId
      wolfTarget: null,
      wolvesAllVoted: false, // true when all living wolves have voted
      seerTarget: null,
      witchSave: null, // true|false|null (null = not decided)
      witchPoisonTarget: null,
      witchPrompted: false, // avoid prompting witch multiple times
      witchPoisonDecided: false, // true after witch chose use or skip poison
      guardTarget: null // guard protects this player
    },
    day: {
      votes: new Map(), // voterId -> targetId
      revote: false,
      revoteCandidates: [] // userIds
    },
    ability: {
      witchAntidoteUsed: false,
      witchPoisonUsed: false
    }
  };
}

export function listPlayers(room) {
  return [...room.players.values()].map((p) => p.name);
}

export function pickRoles(playerIds) {
  const ids = [...playerIds];
  const n = ids.length;
  // Basic "full" flow roles: werewolf + seer + witch + villager
  // Wolf count: 1 (4-5), 2 (6-8), 3 (9-12), else round(n/3)
  let wolfCount = 1;
  if (n >= 9) wolfCount = 3;
  else if (n >= 6) wolfCount = 2;
  if (n > 12) wolfCount = Math.max(3, Math.round(n / 3));

  shuffle(ids);
  const roles = new Map();
  // assign wolves first
  for (let i = 0; i < ids.length; i++) {
    if (i < wolfCount) roles.set(ids[i], "werewolf");
  }
  // assign seer and witch to next available
  const remaining = ids.filter((id) => !roles.has(id));
  if (remaining.length >= 1) roles.set(remaining[0], "seer");
  if (remaining.length >= 2) roles.set(remaining[1], "witch");
  // rest villagers
  for (const id of ids) {
    if (!roles.has(id)) roles.set(id, "villager");
  }
  return roles;
}

export function isGameOver(room) {
  let wolves = 0;
  let villagers = 0;
  for (const uid of room.alive) {
    const r = room.roles.get(uid);
    if (r === "werewolf") wolves++;
    else villagers++;
  }
  if (wolves === 0) return { over: true, winner: "villagers" };
  if (wolves >= villagers) return { over: true, winner: "werewolves" };
  return { over: false };
}

export function startGame(room) {
  room.status = "running";
  room.round = 1;
  room.phase = "night";
  room.lastDeaths = [];
  room.lastPublicLog = "游戏开始，进入黑夜。";
  resetNight(room);
  resetDay(room);
  // initialize optional structures for guard and hunter
  room.hunterShots = new Map(); // shooterId -> targetId
}

export function resetNight(room) {
  room.night.wolfVotes = new Map();
  room.night.wolfTarget = null;
  room.night.wolvesAllVoted = false;
  room.night.seerTarget = null;
  room.night.witchSave = null;
  room.night.witchPoisonTarget = null;
  room.night.witchPrompted = false;
  room.night.witchPoisonDecided = false;
}

export function resetDay(room) {
  room.day.votes = new Map();
  room.day.revote = false;
  room.day.revoteCandidates = [];
}

export function recordWolfVote(room, wolfId, targetId) {
  room.night.wolfVotes.set(wolfId, targetId);
  room.night.wolfTarget = pickMajority(room.night.wolfVotes);
}

export function recordGuardPick(room, targetId) {
  // Guard protects this player for the current night
  room.night.guardTarget = targetId;
}

export function recordSeerCheck(room, targetId) {
  room.night.seerTarget = targetId;
}

export function recordWitchSave(room, save) {
  room.night.witchSave = save;
  if (save) room.ability.witchAntidoteUsed = true;
}

export function recordWitchPoison(room, targetId) {
  room.night.witchPoisonTarget = targetId;
  room.night.witchPoisonDecided = true;
  room.ability.witchPoisonUsed = true;
}

export function canResolveNight(room) {
  // All wolves must have voted; witch must decide save and (if poison available) poison.
  if (!room.night.wolvesAllVoted) return false;
  if (room.night.witchSave === null) return false;
  const poisonDecided =
    room.ability.witchPoisonUsed || room.night.witchPoisonDecided;
  if (!poisonDecided) return false;
  return true;
}

export function resolveNight(room) {
  const deaths = [];
  const wolfTarget = room.night.wolfTarget; // may be null if wolves tied
  const guardProtected = room.night.guardTarget === wolfTarget;
  if (wolfTarget != null && room.alive.has(wolfTarget) && !guardProtected) {
    const saved = room.night.witchSave === true;
    if (!saved) deaths.push(wolfTarget);
  }
  const poisonTarget = room.night.witchPoisonTarget;
  if (poisonTarget && room.alive.has(poisonTarget)) deaths.push(poisonTarget);

  const uniqueDeaths = [...new Set(deaths)];
  for (const uid of uniqueDeaths) room.alive.delete(uid);

  // Record hunter shots after deaths are applied
  if (room.hunterShots) {
    for (const [shooterId, targetId] of room.hunterShots.entries()) {
      if (room.alive.has(shooterId) && room.alive.has(targetId)) {
        // Hunter can shoot a living player
        room.alive.delete(targetId);
        uniqueDeaths.push(targetId);
      }
    }
    // clear after processing
    room.hunterShots.clear();
  }

  room.lastDeaths = uniqueDeaths;
  room.lastPublicLog =
    uniqueDeaths.length === 0 ? "天亮了：昨晚是平安夜。" : `天亮了：昨晚死亡 ${uniqueDeaths.length} 人。`;

  resetNight(room);
  resetDay(room);
  room.phase = "day";
  return uniqueDeaths;
}

export function startVoting(room) {
  room.phase = "voting";
  room.day.votes = new Map();
  room.day.revoteCandidates = room.day.revote ? room.day.revoteCandidates : [];
}

export function recordDayVote(room, voterId, targetId) {
  room.day.votes.set(voterId, targetId);
}

export function tallyDayVotes(room) {
  const counts = new Map();
  const allowTargets =
    room.day.revote && room.day.revoteCandidates.length
      ? new Set(room.day.revoteCandidates)
      : null;

  for (const targetId of room.day.votes.values()) {
    if (allowTargets && !allowTargets.has(targetId)) continue;
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }

  let max = 0;
  let top = [];
  for (const [targetId, c] of counts.entries()) {
    if (c > max) {
      max = c;
      top = [targetId];
    } else if (c === max) {
      top.push(targetId);
    }
  }

  if (top.length === 0) return { type: "no_votes" };
  if (top.length === 1) return { type: "lynch", targetId: top[0], count: max };
  return { type: "tie", candidates: top, count: max };
}

export function applyLynch(room, targetId) {
  if (room.alive.has(targetId)) room.alive.delete(targetId);
  room.phase = "night";
  room.round += 1;
  room.lastDeaths = [];
  room.lastPublicLog = "进入黑夜。";
  resetNight(room);
  resetDay(room);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function pickMajority(votesMap) {
  // Determine the target with the highest vote count.
  // If there is a tie (multiple targets with the same max count), return null so the game can handle it (e.g., no kill).
  const counts = new Map();
  for (const targetId of votesMap.values()) {
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }
  let max = 0;
  let candidates = [];
  for (const [targetId, c] of counts.entries()) {
    if (c > max) {
      max = c;
      candidates = [targetId];
    } else if (c === max) {
      candidates.push(targetId);
    }
  }
  // If a single candidate has the highest votes, return it; otherwise return null.
  return candidates.length === 1 ? candidates[0] : null;
}
