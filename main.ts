import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

// Anh có thể đặt thẳng ở đây hoặc cấu hình ENV trên Coolify
const API_KEY = Deno.env.get("PROXY_API_KEY") || "VIP_KHOABAM_999";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const url = new URL(req.url)
    const targetUrl = url.searchParams.get('url')
    const key = url.searchParams.get('key') || req.headers.get('x-api-key')

    // BẢO MẬT BẰNG API KEY
    if (key !== API_KEY) {
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

    // Bơm Referer giả định cho Upload18/321watch tránh 403 / Bot Fight Mode
    if (targetUrl.includes('321watch.workers.dev') || targetUrl.includes('upload18.org')) {
        headers.set("Referer", "https://upload18.org/");
        headers.set("Origin", "https://upload18.org");
    }

    const targetResponse = await fetch(targetUrl, {
      method: req.method,
      headers: headers
    })

    const body = await targetResponse.blob()
    
    const responseHeaders = new Headers(targetResponse.headers)
    responseHeaders.set('Access-Control-Allow-Origin', '*')
    
    // Gỡ các headers khai báo của máy chủ gốc
    responseHeaders.delete('Report-To')
    responseHeaders.delete('NEL')

    return new Response(body, {
      status: targetResponse.status,
      headers: responseHeaders,
    })
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
