# OP1BOT Chart Scanner

Upload a trading chart screenshot and get a verdict (BUY, SELL or No trade) with a confidence percentage, entry, stop loss, take profits and the number of positions. The analysis uses ICT (liquidity, PD arrays), Smart Money Concepts, the AMD model and Fibonacci OTE, powered by Google Gemini (default `gemini-3.8-flash`).

## Files

- `server.js` – Express server. Calls Gemini, scores the setup and checks the trade plan.
- `index.html` – the app (mobile friendly).
- `package.json` – dependencies and start command.

Keep all three files in the root of the repo (no folders).

## Deploy on Render

1. Create a GitHub repo and upload the three files.
2. Render dashboard → New → Web Service → connect the repo.
3. Settings: Runtime `Node`, Build command `npm install`, Start command `npm start`.
4. Environment variables:

| Name | Required | What it does |
| --- | --- | --- |
| `GEMINI_API_KEY` | yes | Your Google AI Studio key |
| `ACCESS_CODE` | recommended | A password the app asks for. Without it, anyone with your URL can spend your API quota |
| `GEMINI_MODEL` | no | Default `gemini-3.8-flash` |
| `GEMINI_FALLBACKS` | no | Tried in order if the main model fails. Default `gemini-3.7-flash,gemini-3.6-flash` |
| `THINKING_LEVEL` | no | `low`, `medium` (default) or `high`. Higher is slower |
| `MIN_SCORE` | no | Confluence needed before a trade is shown. Default `70` |
| `MIN_RR` | no | Minimum reward:risk to the final target. Default `2` |

5. Deploy, then open the Render URL. The free plan sleeps after inactivity, so the first load can take about a minute.

## How "high confirmation" works

Gemini scores nine checks (higher-timeframe bias, liquidity sweep, market structure shift, displacement/FVG, PD array entry, premium/discount, AMD phase, liquidity target, Fibonacci OTE). The server then decides whether a trade is shown:

- A sweep, a structure shift and a PD array entry are all required.
- Confluence must reach `MIN_SCORE`.
- Stop loss and targets must sit on the correct sides of the entry, with at least `MIN_RR` to the final target.
- The price axis must be readable and the chart quality must not be poor.

If any rule fails, the result is No trade and the app lists what is missing and what to wait for.

The confidence percentage blends the checklist score (70%) with the model's own rating (30%). It is a confluence rating, not a win probability. Nothing here is financial advice, and prices are read from a screenshot, so confirm them on your platform before trading.
