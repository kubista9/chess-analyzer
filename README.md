# Chess Analyst

Local-first Chess.com analysis for recent public games. You provide a Chess.com username and the app pulls the latest 50, 100, or 150 rapid, blitz, and bullet games, then runs Stockfish-backed analysis to surface:

- Dashboard metrics like win rate, accuracy, blunders, average game length, and rating context
- A filtered game-history table with opening search plus result/color filters
- A deep review page for a selected game with move labels such as `best`, `good`, `mistake`, `miss`, and `blunder`
- Opening diagnostics grouped by opening family
- A rule-based weekly training plan built from your recurring mistakes

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

The backend API runs on `http://localhost:3001` and Vite proxies `/api` requests automatically.

## Production build

```bash
npm run build
npm start
```

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
STOCKFISH_PATH=/absolute/path/to/stockfish
STOCKFISH_THREADS=4
STOCKFISH_HASH_MB=192
BATCH_MOVE_TIME_MS=110
BATCH_REPLY_TIME_MS=65
REVIEW_MOVE_TIME_MS=360
REVIEW_REPLY_TIME_MS=180
CHESS_ANALYZER_SKIP_ENGINE_DOWNLOAD=1
```
