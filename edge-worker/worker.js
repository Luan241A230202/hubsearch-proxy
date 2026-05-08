// ============================================================
// CF Worker Edge Cache — Layer 2 (sits in front of Coolify)
// Architecture: User → CF Worker (edge) → Coolify (memory) → 321watch
// ============================================================

const COOLIFY_ORIGIN = 'https://proxy-vps.vnhell.com';
const API_KEY = 'VIP_KHOABAM_999';
const SEGMENT_CACHE_TTL = 7200; // 2 hours

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response('ok', {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type, x-api-key',
        }
      });
    }

    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');
    const key = url.searchParams.get('key') || url.searchParams.get('t');

    // Validate API key
    let authKey = key;
    if (!authKey) return unauthorized();
    // Decode base64 token if needed
    if (!authKey.startsWith('VIP')) {
      try { authKey = atob(authKey); } catch {}
    }
    if (authKey !== API_KEY) return unauthorized();

    if (!targetUrl) {
      return new Response(JSON.stringify({ 
        status: 'ok', 
        layer: 'cf-worker-edge',
        origin: COOLIFY_ORIGIN,
        cacheTTL: SEGMENT_CACHE_TTL 
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // Determine if this is a cacheable segment (not manifest)
    const isSegment = targetUrl.includes('321watch') && 
                      !targetUrl.includes('.m3u8') && 
                      !targetUrl.includes('token_hash');

    // ====== CHECK CF EDGE CACHE ======
    if (isSegment) {
      const cache = caches.default;
      const cacheKey = new Request(request.url, request);
      
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        // Clone and add cache header
        const headers = new Headers(cachedResponse.headers);
        headers.set('X-Cache', 'HIT');
        headers.set('X-Cache-Layer', 'cf-edge');
        return new Response(cachedResponse.body, {
          status: cachedResponse.status,
          headers
        });
      }
    }

    // ====== FORWARD TO COOLIFY ORIGIN ======
    const originUrl = `${COOLIFY_ORIGIN}/?url=${encodeURIComponent(targetUrl)}&key=${API_KEY}`;
    
    try {
      const originResponse = await fetch(originUrl, {
        headers: {
          'User-Agent': 'CF-Edge-Proxy/1.0',
        }
      });

      if (!originResponse.ok) {
        return new Response(originResponse.body, {
          status: originResponse.status,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'X-Cache': 'ERROR',
            'X-Cache-Layer': 'cf-edge',
          }
        });
      }

      // Build response headers
      const responseHeaders = new Headers();
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('X-Cache-Layer', 'cf-edge');
      
      // Copy content-type from origin
      const ct = originResponse.headers.get('Content-Type');
      if (ct) responseHeaders.set('Content-Type', ct);

      // Copy origin cache status  
      const originCache = originResponse.headers.get('X-Cache');
      responseHeaders.set('X-Cache-Origin', originCache || 'NONE');

      if (isSegment) {
        // Cache at CF edge
        responseHeaders.set('X-Cache', 'MISS');
        responseHeaders.set('Cache-Control', `public, max-age=${SEGMENT_CACHE_TTL}`);
        
        const responseBody = await originResponse.arrayBuffer();
        const response = new Response(responseBody, {
          status: 200,
          headers: responseHeaders,
        });

        // Store in CF edge cache (background, non-blocking)
        const cache = caches.default;
        const cacheKey = new Request(request.url, request);
        ctx.waitUntil(cache.put(cacheKey, response.clone()));

        return response;
      } else {
        // Non-segment: stream through without caching
        responseHeaders.set('X-Cache', 'BYPASS');
        return new Response(originResponse.body, {
          status: originResponse.status,
          headers: responseHeaders,
        });
      }

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message, layer: 'cf-edge' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};

function unauthorized() {
  return new Response('Unauthorized', { 
    status: 401, 
    headers: { 'Access-Control-Allow-Origin': '*' } 
  });
}
