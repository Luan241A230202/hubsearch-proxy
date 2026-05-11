
// Anh có thể đặt thẳng ở đây hoặc cấu hình ENV trên Coolify
const API_KEY = Deno.env.get("PROXY_API_KEY") || "VIP_KHOABAM_999";

// ====== R2 PERSISTENT CACHE (L2) — S3 API Direct ======
// Coolify PUT trực tiếp vào R2 qua S3 API (không cần Worker)
// User GET từ R2 custom domain (CF CDN cached → FREE egress)
const R2_ACCESS_KEY = Deno.env.get("R2_ACCESS_KEY_ID") || '';
const R2_SECRET_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY") || '';
const R2_ENDPOINT = Deno.env.get("R2_ENDPOINT") || 'https://a58d6a01ea612aa2cc14b1594e642d5b.r2.cloudflarestorage.com';
const R2_BUCKET = Deno.env.get("R2_BUCKET") || 'streams-cache';
const R2_PUBLIC_URL = Deno.env.get("R2_PUBLIC_URL") || 'https://r2.zohup.net';
const R2_ENABLED = !!(R2_ACCESS_KEY && R2_SECRET_KEY && R2_ENDPOINT);

// Set of keys known to exist in R2 (avoids HEAD requests)
const r2KnownKeys = new Set<string>();
let r2Uploads = 0;
let r2Hits = 0;
let r2Errors = 0;

// ====== IN-MEMORY SEGMENT CACHE (L1) ======
// Cache segments from 321watch to reduce upstream requests
// - Max 500 entries (~750MB RAM)
// - TTL: 2 hours (segments don't change)
// - LRU eviction: oldest entries removed first
const CACHE_MAX_ENTRIES = 500;
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
  // e.g., https://xx.321watch.workers.dev/s/HASH → s/HASH (without leading /)
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\//, ''); // remove leading / for R2 key
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
  'Access-Control-Max-Age': '86400', // Cache CORS preflight 24h → reduce 50% requests
}

// ====== R2 S3 API — AWS Signature V4 ======
async function hmacSha256(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function s3SignedHeaders(method: string, path: string, contentType: string, bodyHash: string): Promise<Record<string, string>> {
  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const shortDate = dateStamp.slice(0, 8);
  const region = 'auto'; // R2 uses 'auto'
  const service = 's3';
  const scope = `${shortDate}/${region}/${service}/aws4_request`;
  
  // Parse endpoint to get host
  const endpointUrl = new URL(R2_ENDPOINT);
  const host = endpointUrl.host;
  
  // Canonical headers
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${host}`,
    `x-amz-content-sha256:${bodyHash}`,
    `x-amz-date:${dateStamp}`,
  ].join('\n') + '\n';
  
  // Canonical request
  const canonicalRequest = [
    method, `/${R2_BUCKET}/${path}`, '', canonicalHeaders, signedHeaders, bodyHash
  ].join('\n');
  
  const canonicalRequestHash = await sha256Hex(new TextEncoder().encode(canonicalRequest));
  
  // String to sign
  const stringToSign = `AWS4-HMAC-SHA256\n${dateStamp}\n${scope}\n${canonicalRequestHash}`;
  
  // Signing key
  const kDate = await hmacSha256(new TextEncoder().encode(`AWS4${R2_SECRET_KEY}`), shortDate);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'aws4_request');
  
  const signature = [...new Uint8Array(await hmacSha256(kSigning, stringToSign))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
  
  return {
    'Authorization': `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-date': dateStamp,
    'x-amz-content-sha256': bodyHash,
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=604800', // 7 days CDN cache
  };
}

// Upload segment to R2 via S3 PUT (non-blocking, background)
async function r2Upload(key: string, data: Uint8Array, contentType: string): Promise<boolean> {
  if (!R2_ENABLED) return false;
  try {
    const bodyHash = await sha256Hex(data);
    const headers = await s3SignedHeaders('PUT', key, contentType, bodyHash);
    
    const resp = await fetch(`${R2_ENDPOINT}/${R2_BUCKET}/${key}`, {
      method: 'PUT',
      headers,
      body: data,
    });
    
    if (resp.ok) {
      r2KnownKeys.add(key);
      r2Uploads++;
      return true;
    }
    r2Errors++;
  } catch {
    r2Errors++;
  }
  return false;
}

function getR2PublicUrl(key: string): string | null {
  if (!R2_PUBLIC_URL || !r2KnownKeys.has(key)) return null;
  return `${R2_PUBLIC_URL}/${key}`;
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
          L1_memory: {
            entries: segmentCache.size,
            maxEntries: CACHE_MAX_ENTRIES,
            totalSizeMB: (totalSize / 1024 / 1024).toFixed(1),
            hits: cacheHits,
            misses: cacheMisses,
            evictions: cacheEvictions,
            hitRate: cacheHits + cacheMisses > 0 
              ? ((cacheHits / (cacheHits + cacheMisses)) * 100).toFixed(1) + '%' 
              : '0%',
          },
          L2_r2: {
            enabled: R2_ENABLED,
            publicUrl: R2_PUBLIC_URL || 'not configured',
            knownKeys: r2KnownKeys.size,
            uploads: r2Uploads,
            hits: r2Hits,
            errors: r2Errors,
          },
        }
      }, null, 2), { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      })
    }

    const headers = new Headers();
    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    headers.set("Accept", "application/json, text/html, */*");

    // ====== CHECK CACHE for segments (L1 Memory → L2 R2 CDN → Origin) ======
    if (isSegmentUrl(targetUrl)) {
      const cacheKey = getCacheKey(targetUrl);
      
      // L1: Check memory cache (fastest, < 1ms)
      const cached = cacheGet(cacheKey);
      if (cached) {
        cacheHits++;
        const responseHeaders = new Headers();
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Content-Type', cached.contentType);
        responseHeaders.set('X-Cache', 'HIT-L1');
        responseHeaders.set('X-Cache-Layer', 'memory');
        responseHeaders.set('X-Cache-Entries', segmentCache.size.toString());
        responseHeaders.set('Cache-Control', 'public, max-age=7200');
        
        return new Response(cached.data, {
          status: 200,
          headers: responseHeaders,
        });
      }
      
      // L2: Redirect to R2 CDN domain (0 BW on VPS, CF CDN serves)
      const r2Url = getR2PublicUrl(cacheKey);
      if (r2Url) {
        r2Hits++;
        return Response.redirect(r2Url, 302);
      }
      
      // L2-fallback: Key not in memory set (e.g. after restart)
      // Do NON-BLOCKING background check — don't stall video playback!
      // If segment exists in R2, add to knownKeys for NEXT request
      if (R2_ENABLED && R2_PUBLIC_URL && !r2KnownKeys.has(cacheKey)) {
        // Fire-and-forget: check R2 in background
        fetch(`${R2_PUBLIC_URL}/${cacheKey}`, {
          method: 'HEAD',
          signal: AbortSignal.timeout(2000),
        }).then(resp => {
          if (resp.ok) r2KnownKeys.add(cacheKey); // Next request → R2!
        }).catch(() => {}); // Ignore errors
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
        
        // For segments: collect output, cache in L1 (memory) + L2 (R2)
        if (isSegmentUrl(targetUrl)) {
          const output = await child.output();
          const data = output.stdout;
          
          if (data.byteLength > 0) {
            // L1: Cache in memory
            const cacheKey = getCacheKey(targetUrl);
            cachePut(cacheKey, data, contentType);
            
            // L2: Upload to R2 in background (non-blocking, won't slow response)
            r2Upload(cacheKey, data, contentType);
            
            responseHeaders.set('X-Cache', 'MISS');
            responseHeaders.set('X-Cache-Layer', 'origin');
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
