# Opening names: lichess-org/chess-openings

- Source: https://github.com/lichess-org/chess-openings, the source TSVs `a.tsv` … `e.tsv` (not `dist/`).
- Pinned commit: `c67912be58` (2026-09-20T07:53:39Z), fetched from
  `https://raw.githubusercontent.com/lichess-org/chess-openings/c67912be58/<file>`.
- Licence: CC0-1.0 (public domain dedication); the upstream licence text is `COPYING.txt`.
- Content: columns `eco`, `name`, `pgn`; 3,815 rows plus 5 header lines.
- Update: `node scripts/update-opening-book.mjs [--commit <sha>]` (run by hand, never at runtime),
  then update this file and re-run `npm run check`.

The dataset is a list of names, not a theory book: it also names unsound lines such as the
Busch-Gass Gambit, the Latvian Gambit and the Damiano Defense. The app uses it for names and
"named line" markers only, never as proof that a move is sound.

| File | Bytes | sha256 |
|---|---:|---|
| a.tsv | 66,338 | 41722fa3d44f294357326fe2ca1b956d9e56490b30efcfa68db61114c9df7e10 |
| b.tsv | 77,372 | 310f0997d5a26ac6c9abfabac028e47e78f24356a6ba322cfffbf8f5a3f88d25 |
| c.tsv | 132,306 | b2e64f32e42e6418b327d03a55af65f3a18e762f7cbc0efffc7e9d1ed3aa7343 |
| d.tsv | 69,199 | 58cad40b886bd499717eabcce281d4bfcf00eeadbdc00552f42042cf4aac50d2 |
| e.tsv | 43,453 | 2787c571c16758343352be5a3e1272cb79af9ad32f20884ea6af982026efbe13 |
| COPYING.txt | 7,048 | a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499 |
