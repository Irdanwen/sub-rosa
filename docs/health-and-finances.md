# Health and finances

The decision and its boundaries are [ADR-0099](adr/0099-health-and-finances-are-local-reads-the-person-chooses-to-share.md).
This page is the practical side: what each shell does, which statements are
known, and how to carry data to and from the household budget engine.

## Health

- **iPhone**: Settings › Health. Switch on the measures Sub Rosa may read;
  iOS shows its own sheet once for them. Reads are refreshed when the view
  opens and when the assistant answers a health question.
- **Android**: the same screen; Health Connect shows its permission sheet.
  Without the history permission it answers the thirty days before the first
  grant.
- **Desktop**: no health store. The Health view and the desktop assistant
  show what a phone sent, only for the measures whose **Sync** switch is on
  there.
- Stored: one summary a day per measure. "Delete" removes what Sub Rosa kept,
  never what the health app holds.

## Finances

Import from the Finances view (desktop sidebar, or Settings › Finances on a
phone). Three formats:

| Format | Where it comes from | Notes |
| --- | --- | --- |
| CSV | Every e-banking export | The bank is recognised by its column names (UBS in English or German, PostFinance, Raiffeisen, BCV, Crédit Agricole, BNP Paribas); any other is read generically. The import sheet shows the mapping and a preview; correct it there. |
| OFX / QFX | French banks' "Money" export, most US banks | SGML (version 1, Windows-1252) and XML (version 2). |
| camt.053 | Every Swiss bank's ISO 20022 statement | Pending entries are skipped; a collective booking stays one transaction so balances add up. |

Reading the same or an overlapping statement again adds only what is new.
Rules file transactions (your own first, then common Swiss and French
merchants); "Suggest categories" asks the model for the rest, sending
descriptions only, and nothing is filed until you accept.

The presets were written against public descriptions of each bank's export
and the fixtures in `src-tauri/src/finance/fixtures/`. A bank that changes
its export still imports: fix the columns in the sheet.

## The budget engine bridge

The budget engine (`~/Documents/Codage/budget-engine`, deployed on the home
server under the `hermes` user) keeps its own ledger from its banks' PDF
statements and files them with `config/rules.json`. Sub Rosa never calls it.
Under Finances › Budget engine:

- **Import rules.json**: pick a copy of the engine's `config/rules.json`.
  Its `user` and `rules` lists become Sub Rosa rules (regular expressions, in
  order, after your own). Internal transfers, savings and income keep that
  meaning; any other line keeps the engine's category name.
- **Export rules**: writes Sub Rosa's rules as a `rules.json` with a `user`
  list. Merge those lines into the engine's `config/rules.json` by hand: its
  README asks never to overwrite the file on the server, because the bot
  records category corrections there.
- **Export transactions**: a semicolon CSV with the columns of the engine's
  `v_tx` view (`date;month;account;holder;label;detail;amount;currency;type;cat;sub`),
  for comparing ledgers or a spreadsheet. The engine itself imports PDFs
  only, so this file is not fed to `budget ingest`.
