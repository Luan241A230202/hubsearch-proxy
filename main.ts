
// Anh có thể đặt thẳng ở đây hoặc cấu hình ENV trên Coolify
const API_KEY = Deno.env.get("PROXY_API_KEY") || "VIP_KHOABAM_999";

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
      return new Response("Missing 'url' query parameter", { 
        status: 400, 
        headers: corsHeaders 
      })
    }

    const headers = new Headers();
    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    headers.set("Accept", "application/json, text/html, */*");

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
        body = child.stdout;
        
        // Cần truyền Content-Type đúng nếu là m3u8 hay ảnh
        if (targetUrl.includes('.m3u8') || targetUrl.includes('token_hash')) {
          responseHeaders.set('Content-Type', 'application/vnd.apple.mpegurl');
        } else if (targetUrl.includes('.png')) {
          responseHeaders.set('Content-Type', 'image/png');
        } else if (targetUrl.includes('.jpeg') || targetUrl.includes('.jpg')) {
          responseHeaders.set('Content-Type', 'image/jpeg');
        } else {
          responseHeaders.set('Content-Type', 'application/octet-stream');
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
