# Chess Analyst

Local-first opening analysis for one Chess.com account, `kubista9` (hard-coded as `OWNER_USERNAME` in `shared/constants.ts`). The app pulls kubista9's latest 1, 5, 10, or 25 rapid, blitz, bullet, and daily games, then runs Stockfish-backed analysis to surface:

- Opening diagnostics grouped by opening family
- A game list with opening search plus result/color filters, which links into review
- A review page for a selected game with move labels such as `best`, `good`, `mistake`, `miss`, and `blunder`

## Stack

- React + TypeScript + Vite
- Express + TypeScript API server
- Stockfish 18 downloaded into the repo during `npm install`
- File-based cache under `storage/cache`

## Run locally

```bash
npm install
npm run dev
```

Frontend: [http://localhost:5173](http://localhost:5173)

The backend API runs on `http://127.0.0.1:3001` and Vite proxies `/api` requests automatically. The API listens on loopback only by default; it has no auth.

`.env` in the repo root is loaded by `server/config.ts`, so the server, CLI and verify scripts all see it. Variables already set in the shell win. See `.env.example`.

### Testing from a phone on the LAN

```bash
npm run dev:web -- --host
```

Vite then serves the UI on your LAN IP, and the API itself stays bound to 127.0.0.1. Note that the Vite proxy forwards `/api/*` for every LAN client, so anyone on the network can use the API through Vite while `--host` is on (including endpoints that start long engine jobs). Only use it on a network you trust, and stop it when done.

To expose the API port itself (not recommended), opt in explicitly:

```bash
HOST=0.0.0.0 npm run dev:server   # prints: API exposed on LAN; no auth
```

## Production build

```bash
npm run build
npm start
```

## Checks

```bash
npm run typecheck   # web, server and test tsconfigs
npm test            # vitest (shared/ and server/ tests)
npm run check       # typecheck, then test, then build:web
```

`npm run build` also runs the typecheck first, because `vite build` does not type-check `src/`.

Verify scripts live in `scripts/verify/` and are read-only. They take `--asof YYYY-MM-DD`, meaning the end of that UTC day, inclusive (see `scripts/verify/_lib.ts`).

## Stockfish

The install script downloads Stockfish automatically into:

```text
storage/engines/stockfish/current/stockfish
```

You can override the binary path with:

```bash
STOCKFISH_PATH=/absolute/path/to/stockfish
```

## Notes on move labels

This project approximates Chess.com-style review labels with Stockfish heuristics. The labels are intentionally useful and consistent, but they are not intended to be an exact replica of Chess.com's proprietary scoring logic.

## Tunable environment variables

```bash
PORT=3001
HOST=0.0.0.0 # opt-in LAN exposure; default 127.0.0.1
STOCKFISH_PATH=/absolute/path/to/stockfish
STOCKFISH_THREADS=4
STOCKFISH_HASH_MB=192
BATCH_MOVE_TIME_MS=110
BATCH_REPLY_TIME_MS=65
REVIEW_MOVE_TIME_MS=360
REVIEW_REPLY_TIME_MS=180
CHESS_ANALYZER_SKIP_ENGINE_DOWNLOAD=1
```

`CHESS_OWNER` overrides the owner on the server side. It exists for tests only; the UI always uses `kubista9`.
