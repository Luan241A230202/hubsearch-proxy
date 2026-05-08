
// Anh có thể đặt thẳng ở đây hoặc cấu hình ENV trên Coolify
const API_KEY = Deno.env.get("PROXY_API_KEY") || "VIP_KHOABAM_999";

// ====== IN-MEMORY SEGMENT CACHE ======
// Cache segments from 321watch to reduce upstream requests
// - Max 150 entries (~300MB RAM max assuming ~2MB/segment)
// - TTL: 2 hours (segments don't change)
// - LRU eviction: oldest entries removed first
const CACHE_MAX_ENTRIES = 150;
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

interface CacheEntry {
  data: Uint8Array;
  contentType: string;
  ts: number;
  size: number;
}

const segmentCache = new Map<string, CacheEntry>();
let cacheHits = 0;
let cacheMisses = 0;
let cacheEvictions = 0;

function getCacheKey(url: string): string {
  // Extract the unique segment path from 321watch URL
  // e.g., https://xx.321watch.workers.dev/s/HASH → /s/HASH
  try {
    const u = new URL(url);
    return u.pathname; // /s/HASH is unique per segment
  } catch {
    return url;
  }
}

function cacheGet(key: string): CacheEntry | null {
  const entry = segmentCache.get(key);
  if (!entry) return null;
  
  // Check TTL
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    segmentCache.delete(key);
    return null;
  }
  
  // Move to end (LRU refresh)
  segmentCache.delete(key);
  segmentCache.set(key, entry);
  return entry;
}

function cachePut(key: string, data: Uint8Array, contentType: string) {
  // Evict oldest entries if at capacity
  while (segmentCache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = segmentCache.keys().next().value;
    if (firstKey !== undefined) {
      segmentCache.delete(firstKey);
      cacheEvictions++;
    }
  }
  
  segmentCache.set(key, {
    data,
    contentType,
    ts: Date.now(),
    size: data.byteLength,
  });
}

function isSegmentUrl(url: string): boolean {
  // Cache only actual video segments from 321watch (not manifests, not pages)
  return url.includes('321watch.workers.dev/s/') && 
         !url.includes('.m3u8') && 
         !url.includes('token_hash');
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-api-key, x-proxy-key',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const url = new URL(req.url)
    const targetUrl = url.searchParams.get('url')
    const key = url.searchParams.get('key') || req.headers.get('x-api-key') || req.headers.get('x-proxy-key')
    
    // Also support base64-encoded token param 't' (used by m3u8 segments)
    let authKey = key;
    if (!authKey) {
      const tokenParam = url.searchParams.get('t');
      if (tokenParam) {
        try { authKey = atob(tokenParam); } catch {}
      }
    }

    // BẢO MẬT BẰNG API KEY
    if (authKey !== API_KEY) {
      return new Response("Unauthorized Proxy Gateway - Invalid API Key", { 
        status: 401, 
        headers: corsHeaders 
      })
    }

    if (!targetUrl) {
      // Return cache stats at root for monitoring
      const totalSize = [...segmentCache.values()].reduce((sum, e) => sum + e.size, 0);
      return new Response(JSON.stringify({
        status: "ok",
        cache: {
          entries: segmentCache.size,
          maxEntries: CACHE_MAX_ENTRIES,
          totalSizeMB: (totalSize / 1024 / 1024).toFixed(1),
          hits: cacheHits,
          misses: cacheMisses,
          evictions: cacheEvictions,
          hitRate: cacheHits + cacheMisses > 0 
            ? ((cacheHits / (cacheHits + cacheMisses)) * 100).toFixed(1) + '%' 
            : '0%',
        }
      }, null, 2), { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      })
    }

    const headers = new Headers();
    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    headers.set("Accept", "application/json, text/html, */*");

    // ====== CHECK CACHE for segments ======
    if (isSegmentUrl(targetUrl)) {
      const cacheKey = getCacheKey(targetUrl);
      const cached = cacheGet(cacheKey);
      
      if (cached) {
        cacheHits++;
        const responseHeaders = new Headers();
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Content-Type', cached.contentType);
        responseHeaders.set('X-Cache', 'HIT');
        responseHeaders.set('X-Cache-Entries', segmentCache.size.toString());
        responseHeaders.set('Cache-Control', 'public, max-age=7200');
        
        return new Response(cached.data, {
          status: 200,
          headers: responseHeaders,
        });
      }
      
      cacheMisses++;
    }

    // Bơm Referer giả định cho Upload18/321watch tránh 403 / Bot Fight Mode (TLS Fingerprint)
    let body: any;
    let finalStatus = 200;
    const responseHeaders = new Headers();
    responseHeaders.set('Access-Control-Allow-Origin', '*');

    if (targetUrl.includes('321watch.workers.dev') || targetUrl.includes('upload18.org')) {
        // Sử dụng curl.exe/curl qua subprocess để vượt qua TLS Fingerprinting chặn fetch() của Deno
        const command = new Deno.Command("curl", {
          args: [
            "-sL", // silent, follow redirects
            "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "-H", "Referer: https://upload18.org/",
            "-H", "Origin: https://upload18.org",
            targetUrl
          ],
          stdout: "piped",
          stderr: "piped"
        });
        
        const child = command.spawn();
        
        // Cần truyền Content-Type đúng nếu là m3u8 hay ảnh
        let contentType = 'application/octet-stream';
        if (targetUrl.includes('.m3u8') || targetUrl.includes('token_hash')) {
          contentType = 'application/vnd.apple.mpegurl';
        } else if (targetUrl.includes('.png')) {
          contentType = 'image/png';
        } else if (targetUrl.includes('.jpeg') || targetUrl.includes('.jpg')) {
          contentType = 'image/jpeg';
        } else if (isSegmentUrl(targetUrl)) {
          contentType = 'video/mp2t';
        }
        responseHeaders.set('Content-Type', contentType);
        
        // For segments: collect output and cache it
        if (isSegmentUrl(targetUrl)) {
          const output = await child.output();
          const data = output.stdout;
          
          if (data.byteLength > 0) {
            // Cache the segment
            const cacheKey = getCacheKey(targetUrl);
            cachePut(cacheKey, data, contentType);
            
            responseHeaders.set('X-Cache', 'MISS');
            responseHeaders.set('X-Cache-Entries', segmentCache.size.toString());
            responseHeaders.set('Cache-Control', 'public, max-age=7200');
            
            return new Response(data, {
              status: 200,
              headers: responseHeaders,
            });
          }
          
          // Curl failed — return error
          body = data;
        } else {
          // Non-segment: stream directly (no caching)
          body = child.stdout;
        }
    } else {
        // Web khác thì fetch bình thường
        const targetResponse = await fetch(targetUrl, {
          method: req.method,
          headers: headers
        })
        body = await targetResponse.blob();
        finalStatus = targetResponse.status;
        targetResponse.headers.forEach((value, key) => {
          if (key.toLowerCase() !== 'report-to' && key.toLowerCase() !== 'nel' && key.toLowerCase() !== 'access-control-allow-origin') {
            responseHeaders.set(key, value);
          }
        });
    }

    return new Response(body, {
      status: finalStatus,
      headers: responseHeaders,
    })
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
