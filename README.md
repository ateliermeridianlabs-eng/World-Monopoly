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

Not planned yet: online multiplayer, sound, auctions, mortgages.

## Play locally

```bash
npm install
npm run dev        # http://localhost:5173
```

`npm run build` writes a static site to `dist/` that runs from any folder or host.

Hot-seat play for 2 to 6 players on one device; any seat can be a bot. The game autosaves in the browser.

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
