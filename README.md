# World Monopoly

A 2D economy-heavy Monopoly variant played on real world cities. Web version first (TypeScript + Vite), Roblox port later.

## Goal

Build a playable, realistic Monopoly variant called World Cities Monopoly. The board uses 72 real cities in 9 sections (USA, South America, UK, Germany, China, Russia, Japan, Africa, Australia). Prices are loosely based on real land value, and the game adds real-life economics: salary checkpoints, taxes every turn, utility meters, airports, and regional disasters.

Platform plan: a browser version first (this repo), then a Roblox (Luau) port. All content lives in JSON under `data/` so both versions share it.

## Status

Done:

- [x] Game design: board layout, rules, roles, event cards, disasters (see "Design decisions" below for the open calls).
- [x] Rules engine in TypeScript with no DOM code (`src/engine/`), seeded RNG, serializable state, and unit tests.
- [x] Browser UI: hot-seat play for 2 to 6 players, bots, trading between players, and autosave.
- [x] Bot simulation script that reports game length and win rates.
- [x] CI (tests and build) and a GitHub Pages deploy workflow.
- [x] City art for USA and South America (16 of 72 cities).
- [x] Network layer for online multiplayer (`src/net/`) and its browser UI (lobby, invite link, trade prompts, host-lost and take-over). Not yet tested over the real internet.

## To do

In rough priority order.

1. **Merge the web version into `main`.** Until then, `main` only holds the art.
2. **Turn on GitHub Pages** (Settings > Pages > Source = GitHub Actions) so the game has a public link.
3. **Confirm or change the design defaults** listed under "Design decisions" below. They are placeholders, not final calls. (`data/rules.json`, `data/cards.json`)
4. **Balance the economy.** Every dollar figure is an unverified placeholder. Early bot simulations: games run a median of about 230 rounds without a round limit, players end with about $170 in cash, Entrepreneur wins about 1% of games and Landlord about 15%. Change numbers in `data/rules.json` and `data/roles.json`, then re-run `npm run simulate`.
5. **Make city art for the remaining 56 cities:** UK, Germany, China, Russia, Japan, Africa, Australia. Landmarks per city are already in `data/sections.json`. See "Art" below for how to add a tile.
6. **Art for utilities and special squares** (Water, Gas, Electricity, WiFi, New Year, Airport, Highway, Tax, World Event, Disaster). These use emoji icons for now.
7. **Unify the tile style.** USA tiles are 512x512 with rounded card frames; South America tiles are about 210x220 and edge to edge. Pick one style and size.
8. **Check the real-world data.** City rankings and prices come from general knowledge and have not been checked against a source.
9. **Roblox port:** rewrite `src/engine/` in Luau and load the same `data/*.json`.
10. **Test online multiplayer over the real internet** (two devices, different networks). The UI is built and has only been run with a local in-browser transport.

Not planned yet: sound, auctions, mortgages.

## Play locally

```bash
npm install
npm run dev        # http://localhost:5173
```

`npm run build` writes a static site to `dist/` that runs from any folder or host.

Two ways to play: hot-seat for 2 to 6 players on one device (any seat can be a bot, and the game autosaves in the browser), or online with each player on their own device (see "Online multiplayer").

## Online multiplayer

### How to play online

1. On the start screen, enter your name and press "Host online game". You get a lobby with a 12-character room code (shown as `XXXX-XXXX-XXXX`).
2. Press "Copy invite link" and send it to the others (or give them the code; they paste it under "Join with code").
3. Each guest opens the link, enters a name, and sits in an open seat. Everyone can pick a role that nobody else has. The host can add seats, turn a seat into a bot, rename bots, and set the round limit.
4. When no seat is open, the host presses "Start game". Only the player whose turn it is gets the controls; everyone else sees whose turn it is. A trade offer pops up for the player it is addressed to, even on someone else's turn.
5. Late arrivals can use the room code shown in the side panel; without a seat they watch.

If someone drops: reloading the page puts a player back in their seat. If a player stays away, the host can press "Hand to bot" next to their name; the player gets the seat back when they return. If the host drops, everyone sees "Host disconnected" and the board stays up. The host gets the game back by reloading the page (the main menu offers "Resume hosted game"), or any player can press "Take over as host" to continue from the last state their device received.

To try it alone, open the link in a private window (or another browser). Two tabs in the same browser count as one player.

For development, `npm run dev` with `?memnet=1` in the URL replaces the network with a same-browser channel, so tabs on one machine form a room without relays; add `&as=ann` and `&as=bob` to give each tab its own player identity. `npm run e2e` drives such a room with a headless Chrome (needs `npm i --no-save playwright-core`; set `CHROME` to the browser path if it is not `/usr/bin/google-chrome`).

### How it works

Peer-to-peer over WebRTC, with no game server. Players find each other through public Nostr relays via [Trystero](https://github.com/dmotz/trystero) (`@trystero-p2p/nostr`, 6 relays in parallel); after that, game messages go browser to browser. The 12-character room code (in the link as `#room=ABCDEFGHJKMN`) is the room name and its password. It is the room's only secret. Relays see a topic that is a fast, unsalted hash of the code, which is why the code is 12 characters: a shorter one could be guessed from public relay traffic. Twelve characters make guessing impractical; they do not add accounts or authentication.

- One browser is the host. It holds the real game state, runs the engine and the bots, and sends the full state to everyone after every change. Guests only send requests ("roll", "buy", "build 37") and show what the host sends.
- Trust model: the host decides everything, so a host can cheat, and anyone with the room code can join, watch, or claim to be the new host. Share the link only with people you are playing with, and play with people you would hand the dice to.
- Guests check every message they receive and the host checks every request: wrong turn, wrong seat, bad shapes and engine errors are refused and the reason is shown to the sender.
- Trades between humans wait for the other player's answer. While an offer is open the proposer can only cancel it or end the turn, and ending the turn cancels it. Trades with bots are answered at once.
- A player who reloads gets their seat back (a private key in `localStorage` identifies the browser; snapshots only show a hash of it). The host can hand an absent player's seat to a bot; the player gets it back when they return.
- The host saves the room in `localStorage`; a host reload resumes it. If the host is gone for good, any guest can take over from the last state they saw. If two hosts ever exist, everyone follows the newest one and the other steps down.

TURN fallback: about 10-15% of networks (strict firewalls, some mobile carriers) block direct connections. Set these at build time to add a TURN relay; without them only direct connections are tried.

| Variable | Example |
| --- | --- |
| `VITE_TURN_URLS` | `turn:turn.example.com:3478,turns:turn.example.com:5349` |
| `VITE_TURN_USERNAME` | `user` |
| `VITE_TURN_CREDENTIAL` | `secret` |

Anything set here ends up in the static site and is public. Use a TURN service with its own quota limits or short-lived credentials.

Known limits:

- Depends on public Nostr relays being up. Not tested over the real internet yet; the tests use an in-memory network.
- The host's browser tab must stay open; a sleeping phone or closed tab stalls the game until it comes back or someone takes over.
- Taking over is manual, and a takeover started from an old state loses whatever happened after it.
- Two tabs in the same browser count as the same player. Use a private window to test as two players.
- A spectator cannot join mid-game as a player.

## Layout

| Path | What |
| --- | --- |
| `data/` | All game content as plain JSON. Shared by the web build and the future Roblox port. |
| `data/sections.json` | 9 sections, 8 cities each, with price, landmark and image path (`null` = no art yet). |
| `data/rules.json` | Every number: salary, taxes, rent, build costs, utility fees, airport fares, round limit. |
| `data/roles.json` | The 6 starting roles and their modifiers. |
| `data/cards.json` | World Event deck. |
| `data/board.json` | The full 144-square board. Generated: edit the files above, then run `npm run board`. |
| `src/engine/` | Game rules. No DOM code, seeded RNG, all state is one serializable object. Port this to Luau. |
| `src/ui/` | Browser UI. |
| `src/net/` | Online multiplayer: protocol and validators, host rules, Trystero transport, session API for the UI. |
| `scripts/simulate.ts` | Runs bot-only games and prints pacing stats: `npm run simulate -- 300 4 200` (games, players, round cap). |
| `assets/cities/` | City tile art (WebP, lowercase slug names). Served as `cities/<slug>.webp`. |

## Board

144 squares, one corner (New Year at square 0), salary checkpoint every 12 squares (12 per lap).

- Each section is 14 squares: 8 cities (cheapest first), Water, Gas, Electricity, WiFi, one World Event, one Disaster.
- Sections run cheapest to priciest by average city price: Africa, Russia, South America, Japan, Australia, UK, Germany, USA, China.
- Between sections: 8 airports, 5 highways (safe), 4 tax offices.

## Art

City art exists for USA and South America. The other 56 cities show a placeholder (initials in a dashed circle in the section colour). To add art: drop `<slug>.webp` in `assets/cities/`, set `"image": "cities/<slug>.webp"` in `data/sections.json`, run `npm run board`.

## Design decisions made in code (all changeable in `data/`)

These were open in the design doc. Each is a default, not a final call.

- Board size 144 (closes the square count: 9 x 14 + 8 airports + 5 highways + 4 tax + New Year).
- Visa denied card: back to the nearest airport behind you (jail no longer exists).
- Section rent bonus counts cities and utilities (12 squares, cap +110%). `rent.sectionBonusCounts`.
- Utility meters only earn while the owner holds a city in that section. `utilities.requiresCityInSection`.
- Japan disasters: Earthquake, Typhoon. Russia: Wildfire, River Flood.
- Disasters hit the whole section (all owners), not only the player who landed.
- Hotels need all 8 cities of the section; houses need none.
- Doubles do not grant extra rolls. No auctions or mortgages. Debt auto-sells buildings, then properties at 50%.
- Destroy disasters and "swap places" pick automatically instead of asking the player.
- Round limit (default 60) ends the game by net worth, because unlimited 4-bot games run a median of about 230 rounds.
