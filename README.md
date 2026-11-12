# World Monopoly

**World Cities Monopoly** is an economy-heavy property-trading board game played on 72 real cities around the world. Players earn a salary, pay taxes every turn, buy cities, build houses and hotels, own utility meters and airports, and survive regional disasters. The last player still solvent, or the richest player when the round limit hits, wins.

Web version first (TypeScript + Vite, this repo). Roblox (Luau) port later. All game content lives in JSON under `data/`, so both versions share one source of truth.

> **Status of the numbers:** every dollar figure, price, rate and fee in this README is an **unverified gameplay placeholder** taken from `data/*.json`. City prices are loosely based on real land value with deliberate skews (see [Sections and cities](#2-sections-and-cities)). Nothing here has been checked against a real-estate data source yet.
>
> **Name:** "Monopoly" is a registered trademark of Hasbro. This is an independent, original game with its own board, rules and art. The working title should be replaced before any public release (see [Roadmap](#roadmap)).

---

## Contents

- [Rules](#rules)
  1. [Overview](#1-overview)
  2. [Sections and cities](#2-sections-and-cities)
  3. [Board layout](#3-board-layout)
  4. [Setup and starting roles](#4-setup-and-starting-roles)
  5. [Turn flow](#5-turn-flow)
  6. [Salary and taxes](#6-salary-and-taxes)
  7. [Buying property](#7-buying-property)
  8. [City rent](#8-city-rent)
  9. [Houses and hotels](#9-houses-and-hotels)
  10. [Utility meters](#10-utility-meters)
  11. [Airports and flights](#11-airports-and-flights)
  12. [Highways and Tax Offices](#12-highways-and-tax-offices)
  13. [World Event cards](#13-world-event-cards)
  14. [Disasters](#14-disasters)
  15. [Losing turns (no jail)](#15-losing-turns-no-jail)
  16. [Trading](#16-trading)
  17. [Debt and bankruptcy](#17-debt-and-bankruptcy)
  18. [Winning](#18-winning)
  19. [Net worth](#19-net-worth)
- [Design decisions still open](#design-decisions-still-open)
- [Roadmap](#roadmap)
- [Play locally](#play-locally)
- [Repository layout](#repository-layout)
- [Art](#art)

---

# Rules

## 1. Overview

| Item | Value |
| --- | --- |
| Players | 2 to 6 (any seat can be a bot) |
| Board | 144 squares, one corner (New Year) |
| Dice | 2 six-sided dice, moved as a total (2 to 12) |
| Starting cash | $1,500, adjusted by role |
| Default length | 60 rounds, then the richest player wins (set to 0 to play until one player is left) |

What makes it different from a classic property game:

- **Taxes every turn.** Cost of living is charged on every roll, income tax at every salary checkpoint, property tax once per lap. The economy shrinks unless you buy rent-producing property early.
- **No full set needed to build houses.** Rent instead grows with how much of a section you own.
- **Utility meters** charge a fee every time anyone builds in their section.
- **Airports** let you fly anywhere on the board for a fare.
- **Disasters** damage buildings region by region.
- **No jail, no free parking, no "go to jail".**

## 2. Sections and cities

The board has **9 sections**. Each has **8 cities + 4 utility meters**, plus one World Event square and one Disaster square.

Price tiers decide house cost and cost-of-living weight:

| Tier | Price range | Tier level | House cost |
| --- | --- | --- | --- |
| Low | up to $150 | 1 | $50 |
| Mid | $151 to $320 | 2 | $100 |
| High | over $320 | 3 | $200 |

Cities in board order (cheapest first). Prices in USD:

| # | Section | Cities and prices |
| --- | --- | --- |
| 1 | Africa | Addis Ababa $60, Accra $70, Lagos $90, Nairobi $100, Casablanca $110, Cairo $120, Johannesburg $140, Cape Town $180 |
| 2 | Russia | Novosibirsk $80, Nizhny Novgorod $80, Yekaterinburg $90, Vladivostok $90, Kazan $100, Sochi $130, Saint Petersburg $150, Moscow $220 |
| 3 | South America | Caracas $70, Medellin $90, Lima $100, Bogota $110, Santiago $120, Buenos Aires $140, Rio de Janeiro $150, Sao Paulo $200 |
| 4 | Japan | Sapporo $90, Fukuoka $110, Kobe $120, Nagoya $130, Kyoto $140, Yokohama $150, Osaka $160, Tokyo $220 |
| 5 | Australia | Newcastle $90, Adelaide $110, Gold Coast $120, Canberra $130, Perth $140, Brisbane $150, Melbourne $180, Sydney $220 |
| 6 | UK | Liverpool $120, Leeds $140, Glasgow $200, Birmingham $220, Bristol $240, Manchester $260, Edinburgh $300, London $580 |
| 7 | Germany | Leipzig $110, Cologne $150, Dusseldorf $220, Hamburg $240, Stuttgart $260, Berlin $300, Frankfurt $320, Munich $540 |
| 8 | USA | Houston $140, Seattle $280, Chicago $300, Miami $440, Washington DC $480, Los Angeles $520, San Francisco $560, New York $600 |
| 9 | China | Chongqing $150, Chengdu $260, Hangzhou $300, Guangzhou $460, Shenzhen $540, Beijing $560, Shanghai $580, Hong Kong $600 |

Pricing skew (a design choice, not a real-world claim): USA and China are high-tier heavy, UK and Germany mid-tier heavy, every other section low-tier heavy. Japan and Australia being cheap contradicts real land prices; this is deliberate for gameplay. Inside each section, city order follows real relative cost. City selection and ranking come from general knowledge and have not been checked against a source.

## 3. Board layout

144 squares, numbered 0 to 143, moving forward (clockwise). Square 0 is **New Year**, the only corner.

**Inside every section** (14 squares, always in this order):

| Slot | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Square | City 1 | City 2 | Water | City 3 | World Event | City 4 | Gas | City 5 | City 6 | Electricity | Disaster | City 7 | WiFi | City 8 |

City 1 is the cheapest and City 8 the most expensive.

**Between sections:** an airport followed by a highway or tax office, alternating. The last gap is a single highway leading back to New Year.

| Squares | Contents |
| --- | --- |
| 0 | New Year |
| 1 to 14 | Africa |
| 15, 16 | Airport 1, Highway 1 |
| 17 to 30 | Russia |
| 31, 32 | Airport 2, Tax Office |
| 33 to 46 | South America |
| 47, 48 | Airport 3, Highway 2 |
| 49 to 62 | Japan |
| 63, 64 | Airport 4, Tax Office |
| 65 to 78 | Australia |
| 79, 80 | Airport 5, Highway 3 |
| 81 to 94 | UK |
| 95, 96 | Airport 6, Tax Office |
| 97 to 110 | Germany |
| 111, 112 | Airport 7, Highway 4 |
| 113 to 126 | USA |
| 127, 128 | Airport 8, Tax Office |
| 129 to 142 | China |
| 143 | Highway 5 |

Totals: 72 cities, 36 utility meters, 9 World Event, 9 Disaster, 8 airports, 5 highways, 4 tax offices, 1 New Year = 144.

**Salary checkpoints** sit on every 12th square: 0, 12, 24, 36, 48, 60, 72, 84, 96, 108, 120, 132 (12 per lap). A checkpoint is a marker on whatever square is there, not a separate square.

The exact list is generated into `data/board.json` by `npm run board`.

## 4. Setup and starting roles

1. Choose 2 to 6 players and mark any as bots.
2. Each player **draft-picks a role**. No two players can have the same role.
3. Everyone starts on New Year with $1,500 plus or minus their role adjustment.
4. Seat 1 goes first; play passes in seat order.

| Role | Advantage | Drawback |
| --- | --- | --- |
| Entrepreneur | +$500 starting cash ($2,000) | Never collects salary |
| Banker | 5% interest each New Year on cash above $1,000 | Pays double property tax |
| Diplomat | All airport landing fees and flight fares halved | Section rent bonus capped at +50% (instead of +110%) |
| Industrialist | Houses and hotels cost 20% less | Pays 1.5x utility build fees to meters they do not own |
| Civil Servant | Salary always taxed at a flat 10% | Starts with $300 less ($1,200) |
| Landlord | Always gets the Utility Control Bonus (1.5x) | Cost of living doubled |

Balance logic: each role trades a recurring cost or cap against a one-time or compounding advantage. Role balance is **untested** beyond early bot runs (see [Roadmap](#roadmap)).

## 5. Turn flow

A turn always runs in this order:

1. **Missed turn check.** If you have a "miss next turn" flag (from the Car crash card), your turn is skipped and the flag clears.
2. **Roll** two dice and move forward that many squares.
3. **While moving**, every salary checkpoint you pass *or* land on pays you (section 6). Passing or landing on New Year also triggers the New Year step (section 6). Nothing is skipped on big rolls.
4. **Resolve the square you land on** (sections 7 to 14).
5. **Pay cost of living** (section 6).
6. **Action phase.** In any order, as many times as you can afford:
   - Buy the unowned city, meter or airport you landed on (once).
   - Build houses or hotels on any city you own, anywhere on the board.
   - Sell buildings back to the bank.
   - Propose trades.
   - If you landed on an airport this turn, fly once to any other airport.
7. **End turn.**

Doubles have no special effect: no extra roll, no penalty.

Moving backward (from a card) never pays salary or triggers New Year.

## 6. Salary and taxes

### Salary checkpoints

- Each checkpoint pays a gross salary of **$50**, minus income tax.
- **Income tax** is taken at the checkpoint, based on your net worth at that moment:

| Net worth | Income tax | Net salary |
| --- | --- | --- |
| Under $1,000 | 10% | $45 |
| $1,000 to $2,999 | 18% | $41 |
| $3,000 and up | 25% | $38 (37.5 rounded) |

- Civil Servant always pays 10%. Entrepreneur never collects salary.

### New Year (square 0)

Each time you pass or land on New Year, in this order:

1. The checkpoint salary above (New Year is a checkpoint).
2. Your lap counter goes up by 1.
3. Banker only: interest of 5% on cash above $1,000.
4. **Property tax:** 1% of the purchase price of everything you own (cities, meters, airports). Buildings are not taxed. Banker pays 2%.

### Cost of living (every turn)

Charged after every roll, after the landing square is resolved.

- Add up the tier level of every **city** you own (low 1, mid 2, high 3). Multiply by **$2**. Minimum **$5**.
- **Grace period:** during your first 2 laps it is halved.
- Landlord pays double.
- Example: you own 3 low cities and 2 high cities. Tier sum = 3 + 6 = 9, so 9 x $2 = $18 per turn ($9 during the grace period).

### Tax Office squares

Landing on a Tax Office costs a flat **$100** to the bank.

## 7. Buying property

- You can buy only the square you **landed on** this turn (by roll, card or flight), and only if nobody owns it.
- You must have the full price in cash. You cannot go into debt to buy.
- If you do not buy, the square stays unowned. **There are no auctions.**
- There are **no mortgages.**

| Property | Price |
| --- | --- |
| City | Listed price (section 2) |
| Utility meter | $100 each |
| Airport | $200 each |

## 8. City rent

Landing on a city someone else owns means paying rent to that owner.

**Rent = base rent x building multiplier x (1 + section bonus)**, rounded to the nearest dollar.

- **Base rent** = 8% of the city's price, rounded, minimum $2.
- **Building multiplier:**

| Buildings | Empty lot | 1 house | 2 houses | 3 houses | 4 houses | Hotel |
| --- | --- | --- | --- | --- | --- | --- |
| Multiplier | 1x | 4x | 12x | 28x | 34x | 40x |

- **Section bonus** = +10% for every square the owner holds in that section beyond the first. Both cities and meters count (12 squares), so the cap of **+110%** is reached at full section ownership. Diplomat's cap is +50%.

Rent examples before section bonus:

| City (price) | Base | 1 house | 2 houses | 3 houses | 4 houses | Hotel |
| --- | --- | --- | --- | --- | --- | --- |
| Addis Ababa ($60) | $5 | $20 | $60 | $140 | $170 | $200 |
| Edinburgh ($300) | $24 | $96 | $288 | $672 | $816 | $960 |
| New York ($600) | $48 | $192 | $576 | $1,344 | $1,632 | $1,920 |

With the bonus: an owner holding 6 of the 12 USA squares gets +50%, so a New York hotel charges $2,880. Owning all 12 gives +110%: $4,032.

Landing on a meter someone else owns costs nothing. Meters earn from building, not landing (section 10).

This section bonus is the core trade incentive: completing a section is worth paying a premium for, and rivals can block you by refusing to sell.

## 9. Houses and hotels

- **Houses need no set.** You can build on any city you own, at any time during your action phase, wherever your token is.
- Each city holds up to **4 houses, then 1 hotel** (5 levels). You build one level at a time and can raise the same city several times in one turn.
- **A hotel requires owning all 8 cities in that section.**
- There is no "build evenly" rule.
- **Cost per level** (house or hotel) depends on the city's tier: low $50, mid $100, high $200. Industrialist pays 80%.
- **Utility build fees** are added on top of every level you build (section 10).
- You need the full cost (build + fees) in cash.
- **Selling:** sell one level at a time back to the bank for 50% of that tier's house cost.

## 10. Utility meters

Every section has 4 meters: **Water, Gas, Electricity, WiFi**. Each is owned individually, and you do not need to own a city to buy one.

**Build fee:** every time *anyone* builds a level in that section, they pay each of the 4 meters:

- $10 per house, $30 per hotel.
- To the meter's owner if the meter is **active**, otherwise to the bank.
- A meter is active only while its owner holds **at least one city in that section**.
- You do not pay your own meters.
- Industrialist pays 1.5x on meters they do not own.

So a house always costs its build price plus up to $40 in fees (up to $120 for a hotel), before multipliers.

**Owner multipliers** (stack, then capped at **2x**):

| Condition | Multiplier |
| --- | --- |
| Owner holds all 4 meters in the section | 1.5x |
| Utility Control Bonus: owner holds 5 or more of the section's 8 cities (Landlord always qualifies) | 1.5x |
| Both | 2.25x, capped to 2x |

## 11. Airports and flights

8 airports sit between sections, $200 each.

- **Landing fee:** landing on someone else's airport costs **$25**.
- **Flying:** after landing on any airport (owned or not), you may fly once that turn to any other airport for a **$50** fare.
  - The fare goes to the **destination** airport's owner. If the destination is unowned, it goes to the bank. Flying to your own airport is free.
  - Flying is instant. You do **not** pass checkpoints or New Year on the way and collect no salary.
  - You pay no landing fee at the destination. If the destination is unowned you may buy it.
- **Network bonus:** an owner's fees and fares rise by +10% for each extra airport they own (2 airports +10%, all 8 +70%).
- Diplomat pays half of every fee and fare.

## 12. Highways and Tax Offices

- **Highway:** a safe square. No rent, no tax, no card. Cost of living still applies that turn (it is charged on every roll).
- **Tax Office:** pay $100 to the bank.

## 13. World Event cards

Landing on a World Event square draws the top card of one shared deck (17 cards). It resolves immediately. When the deck runs out it is reshuffled. A card that moves you resolves the new square too (up to 3 chained moves).

**Good**

| Card | Effect |
| --- | --- |
| Startup exit | Collect $150 |
| Inheritance | Collect $200 |
| Tax refund | Collect $50 |
| Local lottery | Collect $100 |
| Property value surge | Collect $10 for each property you own (cities, meters, airports) |
| Remote work bonus | Collect $75 and move forward 2 |

**Bad**

| Card | Effect |
| --- | --- |
| Car crash | Pay $100 and miss your next turn |
| Flight delayed | Your next airport income (landing fee or fare) is skipped |
| Currency devaluation | Pay 10% of your cash |
| Burglary | Pay $75 |
| Tax audit | Pay $150 |
| Natural disaster | Pay $50 for each city you own in this section |
| Visa denied | Move back to the nearest airport behind you and resolve it |

**Neutral / movement**

| Card | Effect |
| --- | --- |
| Rerouted | Advance to the nearest airport ahead. If someone else owns it, pay double the landing fee. You may then fly |
| Advance to New Year | Move forward to New Year, collecting every checkpoint on the way |
| Wrong turn | Go back 3 spaces and resolve that square |
| House swap | Swap positions with a random other player (no square resolves) |

## 14. Disasters

Landing on a section's Disaster square triggers one of that section's disasters, picked at random:

| Section | Disasters |
| --- | --- |
| Africa | Drought, Sandstorm |
| Russia | Wildfire, River Flood |
| South America | Earthquake, Hurricane |
| Japan | Earthquake, Typhoon |
| Australia | Wildfire, Tornado |
| UK | Heatwave, River Flood |
| Germany | Heatwave, River Flood |
| USA | Wildfire, Tornado |
| China | Earthquake, Tsunami |

The disaster hits **every owner** in that section, not just the player who landed:

- **Degrade (70% chance):** every developed city in the section loses 1 building level.
- **Destroy (30% chance):** each owner loses **all** buildings on their single most developed city in the section.
- Land ownership is always kept. Undeveloped cities are unaffected. **No refunds.**

## 15. Losing turns (no jail)

Jail, "just visiting", free parking and "go to jail" do not exist. The only way to lose a turn is the **Car crash** card. The old "go to jail" card is now **Visa denied** (move back to the nearest airport).

## 16. Trading

- On your action phase you can propose a trade to any other active player.
- A trade must include at least one property. It can add cash in one direction.
- Cities keep their buildings when traded.
- The other player accepts or declines. Bots accept only if what they receive is worth at least 30% more than what they give.

## 17. Debt and bankruptcy

When you owe more cash than you have, the game raises money automatically:

1. Sell buildings one level at a time, most developed city first, for 50% of the house cost.
2. Then sell properties to the bank, cheapest first, for 50% of their price. They become unowned.
3. If you still cannot pay, you are **bankrupt**: the creditor receives whatever was raised, all your remaining property goes back to the bank unowned with no buildings, and you are out.

## 18. Winning

- **Last player standing:** when every other player is bankrupt, the remaining player wins.
- **Round limit:** after round 60 (default), the active player with the highest net worth wins. You can also end a game early by net worth.
- Round limit 0 means no limit. Early 4-bot simulations without a limit ran a median of about 230 rounds, which is why the default limit exists.

## 19. Net worth

**Net worth = cash + purchase price of all owned property + building value.** Building value = the tier's house cost x number of levels on each city. Net worth sets your income tax bracket and decides round-limit wins.

---

# Design decisions still open

The design doc left these open. The code uses a **proposed** default for each; none is confirmed yet. All are changeable in `data/`.

| # | Question | Proposed default in code | Where |
| --- | --- | --- | --- |
| 1 | Square count did not close at 120 | Board grown to 144 (9 x 14 + 8 airports + 5 highways + 4 tax + New Year) | `scripts/generate-board.mjs` |
| 2 | Replacement for jail | No jail. Car crash is the only lost turn. "Visa denied" sends you back to the nearest airport | `data/cards.json` |
| 3 | Does the +110% rent cap count 8 cities or all 12 squares? | All 12 (cities and meters). Setting `cities` caps at +70% | `rules.json` `rent.sectionBonusCounts` |
| 4 | Must a meter owner hold a city in the section? | Yes, or fees go to the bank | `rules.json` `utilities.requiresCityInSection` |
| 5 | Disasters for Japan and Russia | Japan: Earthquake, Typhoon. Russia: Wildfire, River Flood | `data/sections.json` |
| 6 | Who a disaster hits | Every owner in the section (the doc said "the affected owner") | `src/engine/game.ts` |
| 7 | Who picks the property in a Destroy disaster | Automatic (most developed). The doc said owner's choice | `src/engine/game.ts` |
| 8 | Hotel eligibility | Needs all 8 cities of the section; houses need none | `rules.json` `building.hotelRequiresFullSection` |
| 9 | "Swap places" target | Random other player (the doc said any player) | `src/engine/game.ts` |
| 10 | Doubles, auctions, mortgages | None | `src/engine/game.ts` |
| 11 | Airport, highway and tax office counts | 8, 5, 4 | `scripts/generate-board.mjs` |
| 12 | Natural disaster card scope | $50 per city you own in the section you are in | `data/cards.json` |
| 13 | Game length | 60-round limit, then net worth decides | `rules.json` `roundLimit` |
| 14 | Optional "Recession" card (halves the next 2 salaries board-wide) | Not added | `data/cards.json` |

---

# Roadmap

## Goal

A playable, realistic economy-focused world-cities property game: browser version first, then a Roblox port, both reading the same `data/*.json`.

## Done

- [x] Game design: board layout, rules, roles, event cards, disasters.
- [x] Rules engine in TypeScript with no DOM code (`src/engine/`), seeded RNG, serializable state, unit tests.
- [x] Browser UI: hot-seat play for 2 to 6 players, bots, trading, autosave.
- [x] Bot simulation script reporting game length and win rates.
- [x] CI (tests and build) and a GitHub Pages deploy workflow.
- [x] City art for USA and South America (16 of 72 cities).

## To do

In rough priority order.

1. **Merge the web version into `main`.** Until then, `main` only holds the art.
2. **Turn on GitHub Pages** (Settings > Pages > Source = GitHub Actions) so the game has a public link.
3. **Confirm or change the open design decisions** above.
4. **Balance the economy.** Early bot runs: median game about 230 rounds without a limit, bots hold about $170 cash, Entrepreneur wins about 1% of games, Landlord about 15%. Those two roles need tuning. Change numbers in `data/rules.json` and `data/roles.json`, then re-run `npm run simulate`. Ideally calibrate prices against real price-per-square-metre data first.
5. **City art for the remaining 56 cities:** UK, Germany, China, Russia, Japan, Africa, Australia. Landmarks per city are in `data/sections.json`.
6. **Art for utilities and special squares** (Water, Gas, Electricity, WiFi, New Year, Airport, Highway, Tax, World Event, Disaster). These use emoji for now.
7. **Unify tile style.** USA tiles are 512x512 with rounded card frames; South America tiles are about 210x220 and edge to edge.
8. **Verify real-world data:** city selection, ranking and relative prices.
9. **Pick a final game name** that does not use the "Monopoly" trademark.
10. **Roblox port:** rewrite `src/engine/` in Luau and load the same `data/*.json`.

Not planned yet: online multiplayer, sound, auctions, mortgages.

---

## Play locally

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine unit tests
npm run simulate -- 300 4 200   # games, players, round cap
```

`npm run build` writes a static site to `dist/` that runs from any folder or host. The game autosaves in the browser.

## Repository layout

| Path | What |
| --- | --- |
| `data/` | All game content as plain JSON. Shared by the web build and the future Roblox port. |
| `data/sections.json` | 9 sections, 8 cities each, with price, landmark, disasters and image path (`null` = no art yet). |
| `data/rules.json` | Every number: salary, taxes, rent, build costs, utility fees, airport fares, round limit. |
| `data/roles.json` | The 6 starting roles and their modifiers. |
| `data/cards.json` | World Event deck. |
| `data/board.json` | The full 144-square board. Generated: edit the files above, then run `npm run board`. |
| `src/engine/` | Game rules. No DOM code, seeded RNG, one serializable state object. Port this to Luau. |
| `src/ui/` | Browser UI. |
| `scripts/simulate.ts` | Bot-only games with pacing stats. |
| `assets/cities/` | City tile art (WebP, lowercase slug names). Served as `cities/<slug>.webp`. |

If this README and `data/*.json` ever disagree, the JSON is what the game actually uses.

## Art

Style for every tile: flat icon illustration, one iconic landmark, bold flat colours, no text, no photorealism, no shadows or gradients.

City art exists for USA and South America. The other 56 cities show a placeholder (initials in a dashed circle in the section colour). To add art: drop `<slug>.webp` in `assets/cities/`, set `"image": "cities/<slug>.webp"` in `data/sections.json`, then run `npm run board`.
