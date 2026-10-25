// Cloudflare Worker: Supabase Reverse Proxy for Wallee
const SUPABASE_HOST = 'swmhjxpiwopguxwnjbdv.supabase.co';
const SUPABASE_ORIGIN = `https://${SUPABASE_HOST}`;

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', timestamp: Date.now() }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Rewrite the URL to point to Supabase
    url.hostname = SUPABASE_HOST;
    url.protocol = 'https:';
    url.port = '443';

    // Clone & forward the original headers
    const headers = new Headers(request.headers);
    headers.set('Host', SUPABASE_HOST);
    headers.set('Origin', SUPABASE_ORIGIN);

    // Build the proxied request
    const proxyRequest = new Request(url.toString(), {
      method: request.method,
      headers: headers,
      body: request.method !== 'GET' && request.method !== 'HEAD'
        ? request.body
        : undefined,
      redirect: 'follow',
    });

    try {
      // Forward to Supabase
      const response = await fetch(proxyRequest);

      // Clone response and add CORS headers
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      responseHeaders.set('Access-Control-Allow-Headers', '*');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Proxy error', message: err.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
