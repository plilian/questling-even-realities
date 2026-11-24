# Contributing

1. `npm i -g npm@11 && npm ci`
2. Before a PR: `npm run typecheck && npm run lint && npm test && npm run build`.
3. Keep the invariants: rewards only through the reducer ledger; external writes only via confirmed proposals; no secrets or tokens in client code or storage; 18+ mode enabled only from the consent dialog; glasses pages must pass `validatePage` and the glyph tests.
4. Art: generated glyphs and glasses variants come from `scripts/gen_art.py` (`python3 scripts/gen_art.py`); review `assets/generated/*_sheet.png`.
5. Record new test results in `docs/TESTING.md`.
