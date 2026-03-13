export function createInitialRoom(chatId) {
  return {
    chatId,
    status: "lobby", // lobby | running | ended
    hostId: null,
    players: new Map(), // userId -> { id, username, name }
    roles: new Map(), // userId -> "werewolf" | "villager"
    alive: new Set(), // userIds
    nightKillTarget: null,
    votes: new Map(), // voterId -> targetId
    round: 0
  };
}

export function listPlayers(room) {
  return [...room.players.values()].map((p) => p.name);
}

export function pickRoles(playerIds) {
  const ids = [...playerIds];
  // 1 werewolf for 4-6, 2 for 7-10 (simple rule)
  const wolfCount = ids.length >= 7 ? 2 : 1;
  shuffle(ids);
  const roles = new Map();
  for (let i = 0; i < ids.length; i++) {
    roles.set(ids[i], i < wolfCount ? "werewolf" : "villager");
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

export function tallyVotes(room) {
  const counts = new Map(); // targetId -> count
  for (const targetId of room.votes.values()) {
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }
  let best = null;
  for (const [targetId, c] of counts.entries()) {
    if (!best || c > best.count) best = { targetId, count: c };
  }
  return best; // may be null
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

