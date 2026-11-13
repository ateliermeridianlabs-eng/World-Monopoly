/**
 * Online multiplayer: public API for the UI.
 *
 * Model: one browser (the host) holds the real GameState and runs the engine. Everyone else is a
 * guest: they send intents and render the snapshots the host broadcasts after every change.
 * Bots run only on the host. Read the game from `session.snapshot.game` with the usual engine
 * query helpers (`currentPlayer`, `canBuild`, `netWorth`, ...); never call engine actions on it.
 *
 * Typical flow:
 * ```ts
 * const code = roomCodeFromHash(location.hash) ?? newRoomCode();
 * setRoomInUrl(code);                                   // share roomLink(code, location.href)
 * const transport = createTrysteroTransport(code);
 * const session = iAmHosting
 *   ? hostSession({ transport, roomCode: code, name })  // or { ..., resume: loadHostSave()?.snapshot }
 *   : joinSession({ transport, roomCode: code, name });
 * session.subscribe((rejected) => { if (rejected) toast(rejected); render(session); });
 * session.claimSeat(1); session.setRole('banker');      // lobby
 * session.start();                                      // host
 * session.send({ type: 'roll' });                       // your turn
 * ```
 *
 * Render hints:
 * - `session.selfSeat` is your engine player id (null = spectator). Your turn: `game.current === selfSeat`.
 * - Pending trade for you: `snapshot.pendingTrade?.offer.to === selfSeat`; answer with
 *   `send({ type: 'respondTrade', tradeId: pendingTrade.id, accept })`. The proposer sees the same
 *   pendingTrade and may `send({ type: 'cancelTrade' })`; their other actions are refused until it is
 *   answered, and ending the turn cancels it. Outcomes appear in `game.log`.
 * - Trades with a bot resolve immediately; a bot's refusal arrives as a rejection.
 * - `seat.connected === false` on a human seat: that player is away. The host can
 *   `convertToBot(seat)`; the player gets the seat back by rejoining (same browser).
 * - `status === 'host-lost'`: keep showing the snapshot, offer "Wait" and `takeOverAsHost()`.
 * - `snapshot.hostId === session.clientId` identifies the host's seat (`seat.clientId`); only it may `finish`.
 * - Two tabs in one browser share a client key and therefore a seat; use a private window to test as two players.
 */
export { PROTOCOL_VERSION, NAME_MAX, cleanName, clientIdFromKey, parseMessage, parseIntent, parseLobbyOp, parseSnapshot } from './protocol';
export type { Intent, LobbyOp, Seat, SeatKind, PendingTrade, Snapshot, GuestMessage, HostMessage, Message } from './protocol';
export {
  createTable, applyIntent, applyLobbyOp, addSeat, removeSeat, setSeat, setRoundLimit, startGame, convertToBot,
  setConnected, resetPresence, seatOf, needsBotStep, stepBot,
} from './authority';
export type { Result } from './authority';
export { createTrysteroTransport, createMemoryTransportHub, turnFromEnv, APP_ID, RELAY_REDUNDANCY, MAX_MESSAGE_BYTES } from './transport';
export type { Transport, TrysteroOptions } from './transport';
export {
  Session, hostSession, joinSession, loadHostSave, clearHostSave, newRoomCode, formatRoomCode, normalizeRoomCode, roomCodeFromHash, roomLink, setRoomInUrl,
} from './session';
export type { SessionOptions, SessionRole, SessionStatus, SessionListener, StorageLike, HostSave } from './session';
