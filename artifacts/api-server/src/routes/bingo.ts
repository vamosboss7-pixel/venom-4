import { and, asc, eq, inArray } from "drizzle-orm";
import { db, bingoCalls, bingoPayouts, bingoPlayerCards, bingoRounds, telegramUsers, walletTransactions } from "@workspace/db";
import { Router, type IRouter, type Request } from "express";
import { isValidTelegramInitData, parseTelegramUser } from "./telegram";
import { logger } from "../lib/logger";
import { awardBingoPayout } from "../lib/payout";

const router: IRouter = Router();
const MAX_CARDS = 4;
const CARD_COUNT = 150;
const DEFAULT_BINGO_PAYOUT = "2280.00";
const CARD_STAKE = 4;
const SELECTION_DURATION_MS = 60_000;

function getBingoPayoutAmount() {
  const configured = process.env["BINGO_PAYOUT_AMOUNT"]?.trim();
  return configured && /^\d+(?:\.\d{1,2})?$/.test(configured) ? Number(configured).toFixed(2) : DEFAULT_BINGO_PAYOUT;
}

function winnerCard(grid: Array<number | "star">, called: Set<number>) {
  const marked = (cell: number | "star") => cell === "star" || called.has(cell as number);
  const lines = [
    [0, 1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13, 14],
    [15, 16, 17, 18, 19], [20, 21, 22, 23, 24], [0, 5, 10, 15, 20],
    [1, 6, 11, 16, 21], [2, 7, 12, 17, 22], [3, 8, 13, 18, 23],
    [4, 9, 14, 19, 24], [0, 6, 12, 18, 24], [4, 8, 12, 16, 20],
  ];
  const corners = [0, 4, 20, 24];
  return lines.some((line) => line.every((index) => marked(grid[index]!))) || corners.every((index) => marked(grid[index]!));
}

async function resolveRoundWinner(roundId: number) {
  return db.transaction(async (tx) => {
    const [round] = await tx.select().from(bingoRounds).where(eq(bingoRounds.id, roundId)).for("update").limit(1);
    if (!round) return undefined;
    const calls = await tx.select({ number: bingoCalls.number }).from(bingoCalls).where(eq(bingoCalls.roundId, roundId));
    const cards = await tx.select({ id: bingoPlayerCards.id, telegramId: bingoPlayerCards.telegramId, cardNumber: bingoPlayerCards.cardNumber, grid: bingoPlayerCards.grid }).from(bingoPlayerCards).where(eq(bingoPlayerCards.roundId, roundId));
    let winner = [...cards].sort((left, right) => left.id - right.id).find((card) => winnerCard(card.grid, new Set(calls.map((call) => call.number))));
    if (!winner && round.status === "completed") {
      const [payout] = await tx.select().from(bingoPayouts).where(eq(bingoPayouts.roundId, roundId)).limit(1);
      if (payout) winner = cards.find((card) => card.id === payout.cardId);
      if (!winner) return undefined;
      const player = await tx.select({ firstName: telegramUsers.firstName, lastName: telegramUsers.lastName }).from(telegramUsers).where(eq(telegramUsers.telegramId, winner.telegramId)).limit(1);
      return { telegramId: winner.telegramId, name: [player[0]?.firstName, player[0]?.lastName].filter(Boolean).join(" "), cardNumber: winner.cardNumber, payout: payout!.amount, status: payout!.status };
    }
    if (!winner || !["playing", "active"].includes(round.status)) return undefined;
    const result = await awardBingoPayout({ roundId, cardId: winner.id, telegramId: winner.telegramId, amount: getBingoPayoutAmount() });
    await tx.update(bingoRounds).set({ status: "completed", completedAt: new Date() }).where(and(eq(bingoRounds.id, roundId), inArray(bingoRounds.status, ["playing", "active"])));
    const player = await tx.select({ firstName: telegramUsers.firstName, lastName: telegramUsers.lastName }).from(telegramUsers).where(eq(telegramUsers.telegramId, winner.telegramId)).limit(1);
    return { telegramId: winner.telegramId, name: [player[0]?.firstName, player[0]?.lastName].filter(Boolean).join(" "), cardNumber: winner.cardNumber, payout: result.payout.amount, status: result.payout.status };
  });
}

function shuffledNumbers() {
  const values = Array.from({ length: 75 }, (_, index) => index + 1);
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [values[index], values[swap]] = [values[swap], values[index]];
  }
  return values;
}

function buildCard(cardNumber: number): Array<number | "star"> {
  let seed = cardNumber * 9301 + 49297;
  const random = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const columns: number[][] = [];
  for (let column = 0; column < 5; column += 1) {
    const pool = Array.from({ length: 15 }, (_, index) => column * 15 + index + 1);
    for (let index = pool.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [pool[index], pool[swap]] = [pool[swap], pool[index]];
    }
    columns.push(pool.slice(0, 5));
  }
  return Array.from({ length: 25 }, (_, index) => index === 12 ? "star" : columns[index % 5][Math.floor(index / 5)]);
}

export async function ensureActiveBingoRound() {
  const active = await db.query.bingoRounds.findFirst({ where: inArray(bingoRounds.status, ["selecting", "playing", "active"]), orderBy: [asc(bingoRounds.id)] });
  if (active?.status === "active") {
    const [existingCall] = await db.select({ id: bingoCalls.id }).from(bingoCalls).where(eq(bingoCalls.roundId, active.id)).limit(1);
    const [normalized] = await db.update(bingoRounds).set(existingCall ? { status: "playing" } : { status: "selecting", selectionEndsAt: new Date(Date.now() + SELECTION_DURATION_MS) }).where(and(eq(bingoRounds.id, active.id), eq(bingoRounds.status, "active"))).returning();
    return normalized ?? active;
  }
  if (active?.status === "selecting" && !active.selectionEndsAt) {
    const [normalized] = await db.update(bingoRounds).set({ selectionEndsAt: new Date(Date.now() + SELECTION_DURATION_MS) }).where(and(eq(bingoRounds.id, active.id), eq(bingoRounds.status, "selecting"))).returning();
    return normalized ?? active;
  }
  if (active) return active;
  const [created] = await db.insert(bingoRounds).values({ status: "selecting", selectionEndsAt: new Date(Date.now() + SELECTION_DURATION_MS) }).returning();
  if (!created) throw new Error("Could not create Bingo round");
  return created;
}

export async function advanceBingoRound() {
  let round = await ensureActiveBingoRound();
  if (round.status === "selecting" && round.selectionEndsAt && round.selectionEndsAt.getTime() <= Date.now()) {
    const nextStatus = await db.transaction(async (tx) => {
      const [lockedRound] = await tx.select().from(bingoRounds).where(eq(bingoRounds.id, round.id)).for("update").limit(1);
      if (!lockedRound || lockedRound.status !== "selecting" || !lockedRound.selectionEndsAt || lockedRound.selectionEndsAt.getTime() > Date.now()) return lockedRound?.status;
      const cards = await tx.select({ id: bingoPlayerCards.id }).from(bingoPlayerCards).where(eq(bingoPlayerCards.roundId, round.id)).limit(1);
      if (cards.length === 0) {
        await tx.update(bingoRounds).set({ status: "completed", completedAt: new Date() }).where(eq(bingoRounds.id, round.id));
        return "completed";
      }
      await tx.update(bingoRounds).set({ status: "playing", startedAt: new Date() }).where(eq(bingoRounds.id, round.id));
      return "playing";
    });
    if (nextStatus === "completed") return ensureActiveBingoRound();
    round = { ...round, status: "playing" };
  }
  if (round.status === "selecting") return round;
  const calls = await db.query.bingoCalls.findMany({ where: eq(bingoCalls.roundId, round.id), orderBy: [asc(bingoCalls.position)] });
  if (calls.length >= 75) {
    const winner = await resolveRoundWinner(round.id);
    if (!winner) await db.update(bingoRounds).set({ status: "completed", completedAt: new Date() }).where(and(eq(bingoRounds.id, round.id), eq(bingoRounds.status, "active")));
    return ensureActiveBingoRound();
  }
  const remaining = shuffledNumbers().filter((number) => !calls.some((call) => call.number === number));
  await db.insert(bingoCalls).values({ roundId: round.id, number: remaining[0]!, position: calls.length });
  await resolveRoundWinner(round.id);
  return round;
}

async function authenticatedUser(req: Request) {
  const initData = req.header("x-telegram-init-data") ?? req.header("authorization")?.replace(/^tma\s+/i, "");
  const token = process.env["TELEGRAM_BOT_TOKEN"]?.trim();
  if (!initData || !token || !isValidTelegramInitData(initData, token)) return undefined;
  const user = parseTelegramUser(initData);
  if (!user) return undefined;
  return db.query.telegramUsers.findFirst({ where: eq(telegramUsers.telegramId, user.id) });
}

router.get("/bingo/round", async (req, res) => {
  try {
    const requestedRoundId = Number(req.query.roundId);
    const round = Number.isInteger(requestedRoundId) && requestedRoundId > 0
      ? await db.query.bingoRounds.findFirst({ where: eq(bingoRounds.id, requestedRoundId) })
      : await ensureActiveBingoRound();
    if (!round) { res.status(404).json({ error: "Bingo round not found" }); return; }
    const [calls, cards] = await Promise.all([
      db.query.bingoCalls.findMany({ where: eq(bingoCalls.roundId, round.id), orderBy: [asc(bingoCalls.position)] }),
      db.query.bingoPlayerCards.findMany({ where: eq(bingoPlayerCards.roundId, round.id), columns: { id: true, telegramId: true, cardNumber: true, grid: true } }),
    ]);
    const winner = await resolveRoundWinner(round.id);
    res.json({ id: round.id, status: round.status, startedAt: round.startedAt, selectionEndsAt: round.selectionEndsAt, calls: calls.map((call) => ({ number: call.number, position: call.position, calledAt: call.calledAt })), takenCardNumbers: cards.map((card) => card.cardNumber), pot: (cards.length * CARD_STAKE).toFixed(2), winner });
  } catch (error) {
    logger.error({ err: error }, "Failed to load Bingo round");
    res.status(503).json({ error: "Bingo round unavailable" });
  }
});

router.get("/bingo/cards", async (req, res) => {
  const user = await authenticatedUser(req);
  if (!user) { res.status(401).json({ error: "Valid Telegram authentication is required" }); return; }
  const requestedRoundId = Number(req.query.roundId);
  const round = Number.isInteger(requestedRoundId) && requestedRoundId > 0
    ? await db.query.bingoRounds.findFirst({ where: eq(bingoRounds.id, requestedRoundId) })
    : await ensureActiveBingoRound();
  if (!round) { res.status(404).json({ error: "Bingo round not found" }); return; }
  const cards = await db.query.bingoPlayerCards.findMany({ where: and(eq(bingoPlayerCards.roundId, round.id), eq(bingoPlayerCards.telegramId, user.telegramId)), orderBy: [asc(bingoPlayerCards.cardNumber)] });
  res.json({ roundId: round.id, cards });
});

router.post("/bingo/cards/reserve", async (req, res) => {
  const user = await authenticatedUser(req);
  if (!user) { res.status(401).json({ error: "Valid Telegram authentication is required" }); return; }
  const cardNumber = req.body?.cardNumber;
  if (!Number.isInteger(cardNumber) || cardNumber < 1 || cardNumber > CARD_COUNT) { res.status(400).json({ error: "Choose a valid card" }); return; }
  const round = await ensureActiveBingoRound();
  try {
    const result = await db.transaction(async (tx) => {
      const [lockedRound] = await tx.select().from(bingoRounds).where(eq(bingoRounds.id, round.id)).for("update").limit(1);
      const [lockedUser] = await tx.select().from(telegramUsers).where(eq(telegramUsers.telegramId, user.telegramId)).for("update").limit(1);
      if (!lockedRound || !lockedUser || lockedRound.status !== "selecting" || !lockedRound.selectionEndsAt || lockedRound.selectionEndsAt.getTime() <= Date.now()) throw Object.assign(new Error("Card selection is closed"), { status: 409 });
      const reference = `bingo_reservation:${lockedRound.id}:${user.telegramId}:${cardNumber}`;
      const [existingLedger] = await tx.select().from(walletTransactions).where(eq(walletTransactions.reference, reference)).limit(1);
      if (existingLedger) return { reserved: true, wallet: (existingLedger.metadata as { wallet?: string } | null)?.wallet ?? "play", balance: existingLedger.balanceAfter };
      const [existingCard] = await tx.select().from(bingoPlayerCards).where(and(eq(bingoPlayerCards.roundId, lockedRound.id), eq(bingoPlayerCards.cardNumber, cardNumber))).for("update").limit(1);
      if (existingCard) throw Object.assign(new Error("This card is already taken"), { status: 409 });
      const playBalance = Number(lockedUser.playWalletBalance);
      const winBalance = Number(lockedUser.winWalletBalance);
      const wallet = playBalance >= CARD_STAKE ? "play" : winBalance >= CARD_STAKE ? "win" : undefined;
      if (!wallet) throw Object.assign(new Error("Insufficient balance in play and win wallets"), { status: 402 });
      const before = wallet === "play" ? playBalance : winBalance;
      const balance = (before - CARD_STAKE).toFixed(2);
      await tx.insert(bingoPlayerCards).values({ roundId: lockedRound.id, telegramId: user.telegramId, cardNumber, grid: buildCard(cardNumber) });
      await tx.update(telegramUsers).set({ ...(wallet === "play" ? { playWalletBalance: balance } : { winWalletBalance: balance }), updatedAt: new Date() }).where(eq(telegramUsers.telegramId, user.telegramId));
      await tx.insert(walletTransactions).values({ telegramId: user.telegramId, type: "adjustment", amount: (-CARD_STAKE).toFixed(2), balanceBefore: before.toFixed(2), balanceAfter: balance, status: "completed", reference, metadata: { roundId: lockedRound.id, cardNumber, stake: CARD_STAKE, wallet } });
      return { reserved: true, wallet, balance };
    });
    res.status(201).json({ roundId: round.id, ...result });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status) { res.status(status).json({ error: (error as Error).message }); return; }
    logger.error({ err: error }, "Failed to reserve Bingo card");
    res.status(503).json({ error: "Card reservation unavailable" });
  }
});

router.post("/bingo/cards/release", async (req, res) => {
  const user = await authenticatedUser(req);
  if (!user) { res.status(401).json({ error: "Valid Telegram authentication is required" }); return; }
  const cardNumber = req.body?.cardNumber;
  if (!Number.isInteger(cardNumber) || cardNumber < 1 || cardNumber > CARD_COUNT) { res.status(400).json({ error: "Choose a valid card" }); return; }
  const round = await ensureActiveBingoRound();
  try {
    const result = await db.transaction(async (tx) => {
      const [lockedRound] = await tx.select().from(bingoRounds).where(eq(bingoRounds.id, round.id)).for("update").limit(1);
      const [lockedUser] = await tx.select().from(telegramUsers).where(eq(telegramUsers.telegramId, user.telegramId)).for("update").limit(1);
      if (!lockedRound || !lockedUser || lockedRound.status !== "selecting") throw Object.assign(new Error("Card selection is closed"), { status: 409 });
      const [card] = await tx.select().from(bingoPlayerCards).where(and(eq(bingoPlayerCards.roundId, lockedRound.id), eq(bingoPlayerCards.telegramId, user.telegramId), eq(bingoPlayerCards.cardNumber, cardNumber))).for("update").limit(1);
      if (!card) return { released: false };
      const reference = `bingo_reservation:${lockedRound.id}:${user.telegramId}:${cardNumber}`;
      const [ledger] = await tx.select().from(walletTransactions).where(eq(walletTransactions.reference, reference)).limit(1);
      const wallet = (ledger?.metadata as { wallet?: string } | null)?.wallet === "win" ? "win" : "play";
      const balanceBefore = Number(wallet === "play" ? lockedUser.playWalletBalance : lockedUser.winWalletBalance);
      const balanceAfter = (balanceBefore + CARD_STAKE).toFixed(2);
      await tx.delete(bingoPlayerCards).where(eq(bingoPlayerCards.id, card.id));
      await tx.update(telegramUsers).set({ ...(wallet === "play" ? { playWalletBalance: balanceAfter } : { winWalletBalance: balanceAfter }), updatedAt: new Date() }).where(eq(telegramUsers.telegramId, user.telegramId));
      await tx.insert(walletTransactions).values({ telegramId: user.telegramId, type: "adjustment", amount: CARD_STAKE.toFixed(2), balanceBefore: balanceBefore.toFixed(2), balanceAfter, status: "completed", reference: `bingo_release:${lockedRound.id}:${user.telegramId}:${cardNumber}`, metadata: { roundId: lockedRound.id, cardNumber, stake: CARD_STAKE, wallet, source: reference } });
      return { released: true, wallet, balance: balanceAfter };
    });
    res.json({ roundId: round.id, ...result });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status) { res.status(status).json({ error: (error as Error).message }); return; }
    logger.error({ err: error }, "Failed to release Bingo card");
    res.status(503).json({ error: "Card release unavailable" });
  }
});

router.post("/bingo/cards", async (req, res) => {
  const user = await authenticatedUser(req);
  if (!user) { res.status(401).json({ error: "Valid Telegram authentication is required" }); return; }
  const cardNumbers = req.body?.cardNumbers;
  if (!Array.isArray(cardNumbers) || cardNumbers.length < 1 || cardNumbers.length > MAX_CARDS || new Set(cardNumbers).size !== cardNumbers.length || cardNumbers.some((value) => !Number.isInteger(value) || value < 1 || value > CARD_COUNT)) {
    res.status(400).json({ error: `Choose between 1 and ${MAX_CARDS} unique cards from 1 to ${CARD_COUNT}` }); return;
  }
  let round = await ensureActiveBingoRound();
  if (round.status === "selecting" && round.selectionEndsAt && round.selectionEndsAt.getTime() <= Date.now()) {
    await advanceBingoRound();
    round = await ensureActiveBingoRound();
  }
  try {
    const result = await db.transaction(async (tx) => {
      const [lockedRound] = await tx.select().from(bingoRounds).where(eq(bingoRounds.id, round.id)).for("update").limit(1);
      const [lockedUser] = await tx.select().from(telegramUsers).where(eq(telegramUsers.telegramId, user.telegramId)).for("update").limit(1);
      if (!lockedUser || !lockedRound || lockedRound.status !== "selecting" || !lockedRound.selectionEndsAt || lockedRound.selectionEndsAt.getTime() <= Date.now()) throw Object.assign(new Error("Card selection is closed"), { status: 409 });
      const existing = await tx.select({ cardNumber: bingoPlayerCards.cardNumber, telegramId: bingoPlayerCards.telegramId }).from(bingoPlayerCards).where(and(eq(bingoPlayerCards.roundId, lockedRound.id), inArray(bingoPlayerCards.cardNumber, cardNumbers))).for("update");
      const takenByOther = existing.find((card) => card.telegramId !== user.telegramId);
      if (takenByOther) throw Object.assign(new Error(`Card ${takenByOther.cardNumber} is already taken`), { status: 409 });
      const current = await tx.select({ cardNumber: bingoPlayerCards.cardNumber }).from(bingoPlayerCards).where(and(eq(bingoPlayerCards.roundId, lockedRound.id), eq(bingoPlayerCards.telegramId, user.telegramId))).for("update");
      const missing = cardNumbers.filter((number) => !current.some((card) => card.cardNumber === number));
      if (current.length + missing.length > MAX_CARDS) throw Object.assign(new Error(`You can select at most ${MAX_CARDS} cards`), { status: 400 });
      const reference = `bingo_purchase:${lockedRound.id}:${user.telegramId}:${missing.slice().sort((a, b) => a - b).join(",")}`;
      const [ledger] = await tx.select().from(walletTransactions).where(eq(walletTransactions.reference, reference)).limit(1);
      if (ledger) {
        const cards = await tx.select().from(bingoPlayerCards).where(and(eq(bingoPlayerCards.roundId, lockedRound.id), eq(bingoPlayerCards.telegramId, user.telegramId))).orderBy(asc(bingoPlayerCards.cardNumber));
        return { cards, balance: ledger.balanceAfter };
      }
      const total = missing.length * CARD_STAKE;
      const playBalance = Number(lockedUser.playWalletBalance);
      const winBalance = Number(lockedUser.winWalletBalance);
      const wallet = playBalance >= total ? "play" : winBalance >= total ? "win" : undefined;
      if (!wallet) throw Object.assign(new Error("Insufficient balance in play and win wallets"), { status: 402 });
      if (missing.length) await tx.insert(bingoPlayerCards).values(missing.map((cardNumber) => ({ roundId: lockedRound.id, telegramId: user.telegramId, cardNumber, grid: buildCard(cardNumber) })));
      const before = wallet === "play" ? playBalance : winBalance;
      const after = (before - total).toFixed(2);
      await tx.update(telegramUsers).set({ ...(wallet === "play" ? { playWalletBalance: after } : { winWalletBalance: after }), updatedAt: new Date() }).where(eq(telegramUsers.telegramId, user.telegramId));
      if (total > 0) await tx.insert(walletTransactions).values({ telegramId: user.telegramId, type: "adjustment", amount: (-total).toFixed(2), balanceBefore: before.toFixed(2), balanceAfter: after, status: "completed", reference, metadata: { roundId: lockedRound.id, cardNumbers: missing, stake: CARD_STAKE, wallet } });
      const cards = await tx.select().from(bingoPlayerCards).where(and(eq(bingoPlayerCards.roundId, lockedRound.id), eq(bingoPlayerCards.telegramId, user.telegramId))).orderBy(asc(bingoPlayerCards.cardNumber));
      return { cards, balance: after };
    });
    res.status(201).json({ roundId: round.id, cards: result.cards, playWalletBalance: result.balance });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status) { res.status(status).json({ error: (error as Error).message }); return; }
    if ((error as { code?: string }).code === "23505") { res.status(409).json({ error: "One of the selected cards was just taken" }); return; }
    logger.error({ err: error }, "Failed to purchase Bingo cards");
    res.status(503).json({ error: "Bingo card purchase unavailable" });
  }
});

export function startBingoRoundInterval() {
  const globalState = globalThis as typeof globalThis & { __bingoInterval?: ReturnType<typeof setInterval>; __bingoTickRunning?: boolean };
  if (globalState.__bingoInterval) return;
  globalState.__bingoInterval = setInterval(() => {
    if (globalState.__bingoTickRunning) return;
    globalState.__bingoTickRunning = true;
    void advanceBingoRound()
      .catch((error) => logger.error({ err: error }, "Bingo round tick failed"))
      .finally(() => { globalState.__bingoTickRunning = false; });
  }, 3_000);
  void ensureActiveBingoRound().catch((error) => logger.error({ err: error }, "Bingo round startup failed"));
}

export default router;
