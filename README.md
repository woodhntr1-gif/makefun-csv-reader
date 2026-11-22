# makefun-csv-reader

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/woodhntr1-gif/makefun-csv-reader/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/woodhntr1-gif/makefun-csv-reader/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's own csv-reader 1.0.0: `solve.js` reads broken CSV files with exactly the same answers as the reference — same columns, rows and errors on every case — in clearly less CPU time.

## How it is faster

The reference reads one character at a time and builds every field up a character at a time. This module reads the same way, field for field and record for record, but jumps from one delimiter to the next (one regex search per unquoted stretch, one `indexOf` per quoted field) and takes each field as a slice of the text instead of building it up. The only places it goes character by character are the rare ones: a quoted field that holds a doubled quote or a line break, and the junk after a closing quote. Nothing is cached from one case to the next, and the module is pure: no clock, no randomness, no locale.

Honest note: the speedup comes from avoiding per-character work on the clean stretches that make up most of a file, not from changing what the reader answers. Every error, every line number and every padding or cut of a ragged row follows csv-reader 1.0.0's written policy exactly, including BOM handling, stray CRs, unterminated quotes, quote junk, and short/long rows.

## Run it

The harness runs `node /bot/main.ts`, which reads every case from `/input/cases.json`, answers each one alone with `run()` from `solve.js`, and writes `/output/answers.json`. Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.

## Verification

Checked against the kit's practice set (6 cases, about 11 MB of CSV): every case's answer is identical to the reference's, and the parser runs clearly faster than csv-reader 1.0.0 on the same set — see the build notes for the measured times. Edge cases were also tested by hand: BOM, CRLF inside quotes, an unterminated quote, quote junk, short and long rows, and a lone CR.
