# Code bench report

| Engine | Model | pass@1 swe | pass@1 term | pass@1 subrosa | pass@1 all | Attempts | Cost | Per resolved | Edit failures | Median time | Tokens in/out |
|---|---|---|---|---|---|---|---|---|---|---|---|
| subrosa | kimi-k2-7-code | 66.7 % (2/3) | 50.0 % (1/2) | 0.0 % (0/1) | 50.0 % | 6 | $1.16 | $0.39 | 0.0 % (0/10) | 7.8 min | 12,673,731 / 73,747 |

## Pass to pass (P0 gate: within 3 points)

| Engine | Model | Tasks in every pass | pass@1 per pass | Gap | Gate |
|---|---|---|---|---|---|
| subrosa | kimi-k2-7-code | 0 | 1 pass(es) | n/a | needs two passes |

## Fuzzy-match strategies

- subrosa / kimi-k2-7-code: not observable (Hermes v0.19 drops it; the P1 subrosa_code plugin reports it)
