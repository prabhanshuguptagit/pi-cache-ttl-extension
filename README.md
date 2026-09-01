# pi-cache-ttl-extension

A countdown to prompt-cache expiry in pi's footer, beside the other cache numbers.

```
↑68 ↓15k R864k W110k CH97.7% cache 4m $1.497 5.0%/1.0M (auto)     claude-opus-5 • high
```

`cache 4m` dim → `cache 45s` warning under a minute → `cache cold` once the TTL is past.
Hidden while a turn is running, and on providers that never report cache usage.

## Install

```sh
pi install git:github.com/prabhanshuguptagit/pi-cache-ttl-extension
```

## TTLs

5 minutes by default. With `PI_CACHE_RETENTION=long`, 1 hour on `anthropic-messages`
and 24 hours on the OpenAI APIs — matching what pi sends (`cache_control.ttl`,
`prompt_cache_retention`).

Exact on Anthropic, where the 5 minutes is a contract and every cache hit resets it.
A rough floor on OpenAI, whose caches are evicted on their own schedule, and on Gemini.

## Footer parity

pi renders extension statuses on their own line, so putting the field beside `CH%`
means replacing the footer. The layout is reproduced from what extensions can read —
`ctx.sessionManager`, `ctx.getContextUsage()`, `footerData` — with two cosmetic gaps:

- `(auto)` is read from `.pi/settings.json` then `~/.pi/agent/settings.json`
  (`compaction.enabled`), so a runtime `/settings` toggle isn't reflected.
- The experimental `xp` marker is not reproduced.
