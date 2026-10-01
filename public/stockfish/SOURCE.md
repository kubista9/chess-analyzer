# Chess engine: Stockfish.js (WASM)

- Source: https://github.com/nmrugg/stockfish.js, release `v19.0.0` (the same files ship in the
  `stockfish@19.0.0` npm package under `bin/`).
- Build: `stockfish-19-lite-single` — the lite network (built into the `.wasm`), single
  threaded. It needs no `SharedArrayBuffer`, so the app needs no cross-origin isolation headers.
- Licence: GPL-3.0 (`Copying.txt`). Stockfish is developed at
  https://github.com/official-stockfish/Stockfish; the WASM port's source is the release above.
  The trainer talks to the engine only over the UCI protocol through `postMessage`.
- Update: `node scripts/update-stockfish.mjs` downloads the pinned files and checks them against
  the sha256 sums in the script; `node scripts/update-stockfish.mjs --check` only verifies.

| File | Bytes | sha256 |
|---|---:|---|
| stockfish-19-lite-single.js | 21,415 | d3344124ab067fb0b90ee77873bb8e9fbf5fc01bc525fe714b0f942581e889e6 |
| stockfish-19-lite-single.wasm | 1,787,571 | 57ac2d72312aba346760e3f173f687a8c211208e97a87268436f7f0e10bb5387 |
