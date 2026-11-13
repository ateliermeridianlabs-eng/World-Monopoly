# World Monopoly

A 2D economy-heavy Monopoly variant played on real world cities. Web version first (TypeScript + Vite), Roblox port later.

## Goal

Build a playable, realistic Monopoly variant called World Cities Monopoly. The board is a world map: 72 real cities in 9 sections (Japan, China, Russia, Germany, UK, USA, South America, Africa, Australia), laid along one route around the world. Prices are loosely based on real land value, and the game adds real-life economics: lap income, salary checkpoints, taxes every turn, utility meters, airports with short-, medium- and long-haul flights, seaports joined by sea routes, and regional disasters. The complete rules are under "Rules" below.

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
4. **Balance the economy.** Every dollar figure is an unverified placeholder, and the $10,000 start and $2,000 lap income dwarf most older figures (salary, taxes, card amounts, prices). Bot simulations (`npm run simulate -- 300 4 300`): games run a median of about 140 rounds without a round limit; average cash falls from $10,000 to about $2,000 by round 50. Change numbers in `data/rules.json` and `data/roles.json`, then re-run `npm run simulate`.
5. **Make city art for the remaining 56 cities:** UK, Germany, China, Russia, Japan, Africa, Australia. Landmarks per city are already in `data/sections.json`. See "Art" below for how to add a tile.
6. **Art for utilities and special squares** (Water, Gas, Electricity, WiFi, New Year, Airport, Seaport, Tax, World Event, Disaster). These use emoji icons for now.
7. **Unify the tile style.** USA tiles are 512x512 with rounded card frames; South America tiles are about 210x220 and edge to edge. Pick one style and size.
8. **Check the real-world data.** City rankings and prices come from general knowledge and have not been checked against a source.
9. **Roblox port:** rewrite `src/engine/` in Luau and load the same `data/*.json`.
10. **Test online multiplayer over the real internet** (two devices, different networks). The UI is built and has only been run with a local in-browser transport.

Not planned yet: sound, auctions, mortgages.

## Rules

The complete rules as implemented. Every number lives in `data/*.json` (file and key in brackets where useful); change it there, not here, and update this section.

### Setup

- 2 to 6 players (`rules.json players`). Each drafts a different role (below). Any seat can be a bot.
- Everyone starts on New Year (square 0) with **$10,000** (`startingCash`) plus their role's starting-cash change: Entrepreneur $10,500, Civil Servant $9,700, everyone else $10,000.
- The World Event deck is shuffled. Player 1 goes first; play goes in seat order.
- Round limit: 60 rounds by default (`roundLimit.default`), settable at setup; 0 means no limit.

### The board

144 squares in one route around the world map: New Year, then for each of the 9 sections (Japan, China, Russia, Germany, UK, USA, South America, Africa, Australia) its 14 territories (8 cities, 4 utility meters, a World Event, a Disaster), each followed by sea squares: an airport plus a seaport or tax office, and after Australia a single seaport back to New Year. In all: 72 cities, 36 utilities, 9 World Events, 9 Disasters, 8 airports, 5 seaports, 4 tax offices, New Year. Every 12th square (0, 12, 24 ... 132) is a ⭐ salary checkpoint.

### A turn

1. **Roll** two six-sided dice and move forward that many squares. Every checkpoint you pass or land on pays salary; reaching or passing New Year pays lap income and New Year's effects (below). There are no doubles rules and no jail.
2. **Land:** the square's effect happens (rent, fee, tax, card, disaster, or the chance to buy).
3. **Cost of living** is charged.
4. **Act**, in any order: buy the square you landed on, build or sell buildings, fly (from an airport) or sail (from a seaport) once, trade, then **end turn**.

A player who must miss a turn (Car crash card) is skipped once.

### Buying

Landing on an unowned city, utility, airport or seaport lets you buy it at its printed price during that turn's action phase (cities $60-$600 by city; utilities $100; airports **$400**; seaports **$300**). There are no auctions and no mortgages. If you do not buy, it stays with the bank.

### Building and rent

- City tiers by price: low up to $150 (house $50), mid up to $320 (house $100), high above $320 (house $200) (`tiers`).
- On your turn you may build one level at a time on any city you own: houses 1-4, then a hotel (level 5). No full set is needed for houses, and building need not be even. A hotel needs all 8 cities of that section.
- Selling a building refunds 50% of its house cost.
- **Rent** (only cities charge rent): base = 8% of price, rounded, at least $2; times 1 / 4 / 12 / 28 / 34 / 40 for an empty lot / 1 / 2 / 3 / 4 houses / hotel.
- **Section bonus:** rent rises 10% for every square the owner holds in that section beyond the first, counting its cities and utility meters (12 squares), capped at +110% (+50% when the owner is a Diplomat).

### Utilities

Each section has Water, Gas, Electricity and WiFi meters ($100 each). Landing on an owned meter costs nothing. Instead, whenever someone builds in that section they pay every meter they do not own a fee: $10 per house, $30 for a hotel. The fee goes to the meter's owner if the owner still has at least one city in that section; otherwise (or if the meter is unowned) it goes to the bank at the base amount. Owner multipliers: x1.5 for owning all four meters of the section, x1.5 more for holding 5 or more of its 8 cities (the Landlord always gets this one), capped at x2. Industrialists pay 1.5x these fees.

### Airports and flights

- **Landing fee:** landing on an airport someone else owns costs **$50**, +10% for each other airport that owner has.
- **Flying:** after your move ends on an airport (by dice or by a card that moves you there), you may fly once that turn to any other airport. The fare depends on the distance between the two airports' seas, measured as a great circle on the real globe (`airports.flightBands`, pairs in `data/board.json flights`):

  | Band | Distance | Fare |
  | --- | --- | --- |
  | Short-haul | up to 5,500 km | $100 |
  | Medium-haul | up to 9,000 km | $200 |
  | Long-haul | over 9,000 km | $400 |

- The fare goes to the destination airport's owner (with their +10% per extra airport), or to the bank if nobody owns it. Flying into your own airport is free. You need the cash for the fare up front.
- On arrival nothing else happens: no landing fee, no further flight or sail this turn. If the airport is unowned you may buy it.
- Flights do not count toward lap income (below): a flight forward skips that progress, and a long flight across New Year skips the payout altogether.

Band for every pair (S/M/L, distance in thousands of km):

| From \ To | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Airport 1 (East China Sea, square 15) | · | S 1.5 | M 8.2 | L 9.1 | L 11.1 | L 14.7 | L 15.7 | M 7.3 |
| Airport 2 (Sea of Japan, square 31) | S 1.5 | · | M 7.6 | M 8.4 | L 10.0 | L 13.2 | L 16.0 | M 8.8 |
| Airport 3 (Baltic Sea, square 47) | M 8.2 | M 7.6 | · | S 1.0 | S 3.7 | M 8.9 | M 8.7 | L 10.3 |
| Airport 4 (North Sea, square 63) | L 9.1 | M 8.4 | S 1.0 | · | S 2.8 | M 7.9 | M 8.1 | L 11.1 |
| Airport 5 (North Atlantic, square 79) | L 11.1 | L 10.0 | S 3.7 | S 2.8 | · | S 5.1 | M 7.6 | L 13.7 |
| Airport 6 (Caribbean, square 95) | L 14.7 | L 13.2 | M 8.9 | M 7.9 | S 5.1 | · | M 7.4 | L 17.3 |
| Airport 7 (South Atlantic, square 111) | L 15.7 | L 16.0 | M 8.7 | M 8.1 | M 7.6 | M 7.4 | · | L 9.9 |
| Airport 8 (Indian Ocean, square 127) | M 7.3 | M 8.8 | L 10.3 | L 11.1 | L 13.7 | L 17.3 | L 9.9 | · |

### Seaports and sea routes

- **Docking fee:** landing on a seaport someone else owns costs **$50**, +10% for each other seaport that owner has.
- **Sailing:** after your move ends on a seaport (by dice or by a card that moves you there), you may sail once that turn along one sea route from that port to the port at its other end. Every route runs both ways. The fare is **$75** (`seaports.sailFare`), paid to the destination port's owner (with their +10% per extra seaport) or to the bank; sailing into your own port is free. Arrival works like a flight's: no fee, no further travel this turn, and you may buy the port if it is unowned. Sailing does not count toward lap income.
- The seaports (the sea zones that used to be highways): East China Port (square 16, East China Sea), Baltic Port (48, Baltic Sea, also a salary checkpoint), North Atlantic Port (80), South Atlantic Port (112), Coral Sea Port (143).
- The sea routes (`data/board.json seaRoutes`):

  | Route | Between |
  | --- | --- |
  | Northern Sea Route | Baltic Port and East China Port (across the Arctic and through the Bering Strait) |
  | Transatlantic Route | Baltic Port and North Atlantic Port |
  | Mid-Atlantic Route | North Atlantic Port and South Atlantic Port |
  | Cape Route | South Atlantic Port and Coral Sea Port (round the Cape of Good Hope, south of Australia) |
  | Western Pacific Route | Coral Sea Port and East China Port |
  | Indian Ocean Route | East China Port and South Atlantic Port (through the Indian Ocean and round the Cape) |

### Lap income and New Year

Each time you reach or pass New Year (by dice or by a card that moves you forward) you collect **lap income**, untaxed, before anything else New Year does:

- lap income = $2,000 x min(1, squares walked since your last lap income / 144), **rounded down to $10** (`lapIncome`).
- *Squares walked* counts only forward movement along the track: dice, and cards that move you forward (Remote work bonus, Rerouted, Advance to New Year, Hitch a ride on a freighter). Flights, sailing, swapping places and moving backward (Wrong turn, Visa denied) do not count. The count resets at each payout; walking more than 144 squares between payouts is not carried over.
- A normal lap pays the full $2,000. Example: you walk from New Year to Airport 1 (15 squares), fly to Airport 4 (square 63) and walk on to New Year (81 more): 96 squares walked, so $2,000 x 96/144 = $1,333.33, rounded down to **$1,330**.
- This makes it impossible to farm: no mix of rolls, flights, sea routes, swaps or cards pays more than $2,000 per 144 squares actually walked.
- The side panel shows each player's progress and what New Year would pay now.

Then, at New Year: the lap counter goes up; a **Banker** earns 5% interest on cash above $1,000 (cash after the lap income); then everyone pays **property tax**: 1% of the total purchase price of everything they own (Banker: 2%). New Year is also a salary checkpoint.

### Salary and income tax

Passing or landing on a ⭐ checkpoint (every 12 squares, 12 per lap, including New Year) pays **$50** salary minus income tax, rounded. Income tax depends on net worth (cash + purchase prices + building value): under $1,000: 10%; under $3,000: 18%; otherwise 25%. Civil Servants pay a flat 10%; Entrepreneurs get no salary at all.

### Cost of living

Charged every turn after you land: $2 per tier level of every city you own (low 1, mid 2, high 3), at least $5. Halved during your first 2 laps. Landlords pay double.

### Tax offices

Landing on a 💰 Tax Office costs $100, paid to the bank.

### World Events

Landing on a ❓ World Event draws the top card (`cards.json`; 19 cards; the deck reshuffles when empty). A card that moves you resolves the square you land on, so cards can chain (at most three draws a turn).

| Card | Effect |
| --- | --- |
| Startup exit | Collect $150. |
| Inheritance | Collect $200. |
| Tax refund | Collect $50. |
| Local lottery | Collect $100. |
| Property value surge | Collect $10 for every property you own. |
| Remote work bonus | Collect $75 and move forward 2. |
| Car crash | Pay $100 and miss your next turn. |
| Flight delayed | Your next airport income is skipped: if it is a landing fee, the player who landed pays nothing; if it is a flight fare, the flyer still pays but you get nothing. Seaport income is not affected. |
| Currency devaluation | Pay 10% of your cash. |
| Burglary | Pay $75. |
| Tax audit | Pay $150. |
| Natural disaster | Pay $50 for each city you own in this section. |
| Visa denied | Go back to the nearest airport behind you (it then works as a normal landing: fee, buy, fly). |
| Rerouted | Advance to the nearest airport ahead. If someone else owns it, pay double the landing fee. You may then buy it or fly. |
| Advance to New Year | Advance to New Year, collecting salary and lap income on the way. |
| Wrong turn | Go back 3 spaces. |
| House swap | Swap places with a random other player (no square effect, no lap progress). |
| Hitch a ride on a freighter | Advance to the nearest seaport ahead. If someone else owns it, pay double the docking fee. You may then buy it or sail. |
| Canal blocked | Pay $100 for each seaport you own. |

### Disasters

Landing on a ⚠️ Disaster strikes that whole section with one of its two disasters (Japan: Earthquake or Typhoon; China: Earthquake or Tsunami; Russia: Wildfire or River Flood; Germany and UK: Heatwave or River Flood; USA and Australia: Wildfire or Tornado; South America: Earthquake or Hurricane; Africa: Drought or Sandstorm). 30% of the time it destroys: each owner there loses every building on their most developed city in the section. Otherwise every developed city in the section loses one level. No refunds; it hits every owner, not just the player who landed.

### Roles

| Role | Effect |
| --- | --- |
| Entrepreneur | +$500 starting cash. No salary checkpoints. |
| Banker | 5% interest per lap on cash above $1,000. Pays double property tax. |
| Diplomat | Pays half at airports and seaports (landing and docking fees, flight and sea fares). Section rent bonus capped at +50%. |
| Industrialist | Build costs 20% cheaper. Pays 1.5x utility build fees to meters they do not own. |
| Civil Servant | Salary taxed at a flat 10%. Starts with $300 less. |
| Landlord | Always gets the utility control bonus (x1.5). Cost of living doubled. |

### Trading

Any player may offer a trade at any time, on anyone's turn, until the game ends: any of their own properties (cities with their buildings, utilities, airports, seaports) and cash for any of the other player's properties. Each player can have one offer open; the other player accepts or declines. Bots accept when what they get is worth at least 30% more (purchase price plus building value) than what they give.

### Debt and bankruptcy

When you owe more cash than you have, your buildings are sold to the bank one level at a time (most developed city first) for 50% of their house cost, then your properties, cheapest first, for 50% of their price. If that still does not cover it, you are bankrupt: you are out, the creditor gets only what you could pay, and everything you owned goes back to the bank unbuilt.

### Winning

The last player who is not bankrupt wins. If the round limit is reached first, the player with the highest net worth (cash + purchase prices of everything owned + building value at house cost per level) wins. The host can also end the game early by net worth.

### Online play notes

Online the host's browser runs these exact rules; guests send requests (roll, buy, build, sell, fly, sail, end turn, trade) and the host refuses anything that is not that player's to do (wrong turn, a sail with no route, a second trip). Saved games and the wire protocol are at version 4; older saves and older clients are refused.

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
4. When no seat is open, the host presses "Start game". Only the player whose turn it is gets the turn controls; everyone else sees whose turn it is. Every seated player has a Trade button at all times, and a trade offer pops up for the player it is addressed to, even on someone else's turn.
5. Late arrivals can use the room code shown in the side panel; without a seat they watch.

If someone drops: reloading the page puts a player back in their seat. If a player stays away, the host can press "Hand to bot" next to their name; the player gets the seat back when they return. If the host drops, everyone sees "Host disconnected" and the board stays up. The host gets the game back by reloading the page (the main menu offers "Resume hosted game"), or any player can press "Take over as host" to continue from the last state their device received.

To try it alone, open the link in a private window (or another browser). Two tabs in the same browser count as one player.

For development, `npm run dev` with `?memnet=1` in the URL replaces the network with a same-browser channel, so tabs on one machine form a room without relays; add `&as=ann` and `&as=bob` to give each tab its own player identity. `npm run e2e` drives such a room with a headless Chrome (needs `npm i --no-save playwright-core`; set `CHROME` to the browser path if it is not `/usr/bin/google-chrome`).

### How it works

Peer-to-peer over WebRTC, with no game server. Players find each other through public Nostr relays via [Trystero](https://github.com/dmotz/trystero) (`@trystero-p2p/nostr`, 6 relays in parallel); after that, game messages go browser to browser. The 12-character room code (in the link as `#room=ABCDEFGHJKMN`) is the room name and its password. It is the room's only secret. Relays see a topic that is a fast, unsalted hash of the code, which is why the code is 12 characters: a shorter one could be guessed from public relay traffic. Twelve characters make guessing impractical; they do not add accounts or authentication.

- One browser is the host. It holds the real game state, runs the engine and the bots, and sends the full state to everyone after every change. Guests only send requests ("roll", "buy", "build 37") and show what the host sends.
- Trust model: the host decides everything, so a host can cheat, and anyone with the room code can join, watch, or claim to be the new host. Share the link only with people you are playing with, and play with people you would hand the dice to.
- Guests check every message they receive and the host checks every request: wrong turn, wrong seat, bad shapes and engine errors are refused and the reason is shown to the sender.
- Trading is allowed at any time, on anyone's turn, before or after the roll, until the game ends. Each player can have one offer open; it waits for the other player's answer, does not block the proposer's own turn, and stays open when turns change. A target with several offers answers them one at a time. The host cancels offers that can no longer happen (a property changed hands, someone went bankrupt or was handed to a bot, the game ended). Trades with bots are answered at once. In hot-seat play the trade window has a "From" picker, since everyone shares the device.
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
| `data/sections.json` | 9 sections, 8 cities each, with price, real lat/lon, landmark and image path (`null` = no art yet). |
| `data/rules.json` | Every number: starting cash, lap income, salary, taxes, rent, build costs, utility fees, airport fees and flight bands, seaport fees and sea fare, round limit. |
| `data/roles.json` | The 6 starting roles and their modifiers. |
| `data/cards.json` | World Event deck. |
| `data/board.json` | The full 144-square board in play order, plus `flights` (every airport pair with its distance and fare band) and `seaRoutes` (which seaports each route joins). Generated: edit the files above (or `scripts/world.mjs`), then run `npm run board`. |
| `data/layout.json` | The world map: every square's territory outline, label point and size, each city's projected location, parcel adjacency, region coastlines, backdrop land, ocean names, the date line, and each sea route's shipping lane (`seaRoutes`). Generated by `scripts/generate-layout.mjs` (run by `npm run board`). |
| `scripts/world.mjs` | Hand-authored map data: region outlines in lon/lat, one cartogram projection per region, the non-city parcel seeds, backdrop land, the sea crossings (with a real lon/lat per sea for flight distances, and the seaport names) and the sea routes. |
| `scripts/lanes.mjs` | Finds each shipping lane: cheapest path by sea on a grid (land is costly, so lanes only cut land at a strait), then smoothed. |
| `src/engine/` | Game rules. No DOM code, seeded RNG, all state is one serializable object. Port this to Luau. |
| `src/ui/` | Browser UI. |
| `src/net/` | Online multiplayer: protocol and validators, host rules, Trystero transport, session API for the UI. |
| `scripts/simulate.ts` | Runs bot-only games and prints pacing stats: `npm run simulate -- 300 4 200` (games, players, round cap). |
| `assets/cities/` | City tile art (WebP, lowercase slug names). Served as `cities/<slug>.webp`. |

## Board

144 squares, New Year at square 0, salary checkpoint every 12 squares (12 per lap).

The board is a political world map (Americas left, Asia and Australia right). Every square is a territory on it, not a card:

- **Regions.** Each section is a recognisable landmass: Japan (four islands), China, Russia, Germany, Britain, the contiguous USA, South America, Africa and Australia. It is a cartogram: each region has its own projection (`PROJ` in `scripts/world.mjs`), so small countries are drawn far larger than true scale while staying in their part of the world, and fisheye lenses spread crowded cities (Osaka-Kobe-Kyoto, Shenzhen-Hong Kong, Sydney-Newcastle...). Directions are kept: inside a region, a city north or west of another really is.
- **Parcels.** Each region is split into its 14 squares like provinces: a Voronoi diagram of 14 seeds clipped to the coastline, relaxed so every parcel has room for its label (largest inscribed circle at least `minRadius` = 0.72 cells). 8 seeds are the cities, placed by their real lat/lon (in `data/sections.json`); the city's dot marks where it really is, inside its parcel. The other 6 parcels are the 4 utility meters, the World Event and the Disaster.
- **Sea zones.** The 17 squares between sections (8 airports, 5 seaports, 4 tax offices) and New Year are patches of sea on the natural crossing: East China Sea, Sea of Japan, Baltic, North Sea, North Atlantic, Caribbean, South Atlantic, Indian Ocean, Coral Sea, and New Year by the International Date Line east of Japan. Each is grown as an organic blob of open water, cut back where it would touch land.
- **Order.** The sections run Japan, China, Russia, Germany, UK, USA, South America, Africa, Australia (west along the north, then east along the south). Inside a section the route starts at the parcel nearest the previous crossing, ends at the parcel nearest the next one, and steps between neighbouring parcels (sharing a border, or a short strait between islands); an exact search picks the shortest such walk. Where the coast leaves no way round (Russia's Far East, Cornwall, Patagonia) the walk takes one short ferry. A dashed line with arrowheads on the map shows the way.
- Each section is followed by an airport and a seaport or tax office; a single seaport (Coral Sea Port) leads from Australia back to New Year.
- **Sea lanes.** The sea routes are drawn as dotted navy shipping lanes that bend around land, with the route's name along them when zoomed in. The Northern Sea Route runs along the Arctic coast, leaves the map at the top right through the Bering Strait and comes back into the Pacific east of Japan.

To change the map, edit `scripts/world.mjs` (or a city's lat/lon) and run `npm run board`: it rebuilds `data/layout.json` and then `data/board.json` (deterministic), and fails if any parcel is too small, not a simple polygon, or loses its city. `tests/layout.test.ts` checks the same rules plus the geography. Square indices changed with this map (version 3); seaports, lap income and flight bands changed the saved state again, so saved games and the online protocol are at version 4.

## Art

City art exists for USA and South America. The other 56 cities show a placeholder (initials in a dashed circle in the section colour). To add art: drop `<slug>.webp` in `assets/cities/`, set `"image": "cities/<slug>.webp"` in `data/sections.json`, run `npm run board`.

## Design decisions made in code (all changeable in `data/`)

These were open in the design doc. Each is a default, not a final call.

- Board size 144 (closes the square count: 9 x 14 + 8 airports + 5 seaports + 4 tax + New Year).
- Visa denied card: back to the nearest airport behind you (jail no longer exists).
- Section rent bonus counts cities and utilities (12 squares, cap +110%). `rent.sectionBonusCounts`.
- Utility meters only earn while the owner holds a city in that section. `utilities.requiresCityInSection`.
- Japan disasters: Earthquake, Typhoon. Russia: Wildfire, River Flood.
- Disasters hit the whole section (all owners), not only the player who landed.
- Hotels need all 8 cities of the section; houses need none.
- Doubles do not grant extra rolls. No auctions or mortgages. Debt auto-sells buildings, then properties at 50%.
- Destroy disasters and "swap places" pick automatically instead of asking the player.
- Round limit (default 60) ends the game by net worth, because unlimited 4-bot games run long (median about 140 rounds).
- Lap income is prorated by squares walked so flights and sailing cannot farm it; it is rounded down to $10 so no mix of moves ever pays more than $2,000 per 144 squares walked.
- Flight bands come from the real great-circle distance between the airports' seas, not from the map, so the band does not depend on the cartogram.
- The "Flight delayed" card only affects airport income, not seaport income.
