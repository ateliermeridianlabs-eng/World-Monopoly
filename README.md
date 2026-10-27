# World Monopoly

A 2D economy-heavy Monopoly variant played on real world cities. Web version first (TypeScript + Vite), Roblox port later.

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
