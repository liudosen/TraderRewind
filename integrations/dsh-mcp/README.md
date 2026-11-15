# TraderRewind MCP for DeepSeek Harness

This bundle registers TraderRewind's local read-only MCP server with DeepSeek
Harness. The model then sees tools named `mcp__traderrewind__*`:

| Tool | What it returns |
|---|---|
| `list_sessions` | All training sessions with PnL, win rate, PF, max drawdown |
| `list_trades` | Every closed order, filterable / paginated |
| `get_trade` | One order with its full fields |
| `get_trade_context` | M1 / M5 / M30 candles around the order, EMA/ATR/RSI, range position, MFE/MAE, 15/30/60-minute excursions |
| `get_candles` | Arbitrary range, any timeframe aggregated from M1 |
| `analyze_trades` | Grouped win/loss stats and drivers |

The server is **read-only**, binds to `127.0.0.1` only, and never places or
modifies orders.

## 1. Start TraderRewind

Open **设置 → MCP**. The default endpoint is:

```
http://127.0.0.1:47821/mcp
```

If the port is taken, change it there. Keep the app running.

## 2. Install the bundle

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm add file:E:\workspace\TraderRewind\integrations\dsh-mcp
```

Then add `@local/traderrewind-mcp` to the profile's `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@local/traderrewind-mcp"
      ]
    }
  }
}
```

Restart DeepSeek Harness. The six tools should appear under
`mcp__traderrewind__*`.

## Alternative: one patch entry

If you prefer not to install a bundle, paste this into
`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`:

```yaml
- insert:
    - id: traderrewind-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: traderrewind
        transport: streamable-http
        url: http://127.0.0.1:47821/mcp
        toolCallTimeoutMs: 120000
        failOnStartupError: false
```

## Notes

- If TraderRewind is closed, DSH still starts; tools reconnect when the app
  comes back. Set `failOnStartupError: true` if you want startup to fail instead.
- `MCP_PORT` is configured in TraderRewind's own settings, not here.
- The server is stateless for practical purposes; restarting either side is safe.
- See `docs/mcp.md` for the full protocol, tool arguments and data conventions.
