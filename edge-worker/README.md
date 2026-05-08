# CF Worker Edge Cache — Layer 2

Cloudflare Worker nằm phía trước Coolify proxy-vps, cache HLS segments tại CF edge (300+ PoPs toàn cầu).

## Architecture
```
User → CF Worker (edge cache) → Coolify proxy-vps (memory cache) → 321watch
         Layer 2                      Layer 1                        Origin
```

## Deploy

### Option 1: Upload trên CF Dashboard
1. Vào [Cloudflare Workers Dashboard](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
2. Create Worker → Upload `worker.js`
3. Worker name: `proxy-vps-edge`

### Option 2: Wrangler CLI
```bash
cd edge-worker
npx wrangler deploy
```

## Sau khi deploy
Copy Worker URL (vd: `https://proxy-vps-edge.phephim.workers.dev`) và paste vào:
- `avdb-player.html` → biến `CF_EDGE`

## Files
- `worker.js` — CF Worker source code
- `wrangler.toml` — Wrangler deploy config
