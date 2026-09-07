interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> }
  API: { fetch: (request: Request) => Promise<Response> }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/_diag') {
      return new Response(
        JSON.stringify({ ok: true, sawPath: url.pathname, at: new Date().toISOString() }),
        { headers: { 'content-type': 'application/json' } },
      )
    }

    if (url.pathname.startsWith('/api/')) {
      // Use the Service Binding to call the API worker directly at the
      // Cloudflare runtime level (no DNS/TLS, no public workers.dev hop).
      // Plain fetch() to another worker's public *.workers.dev URL is not
      // reliable for worker-to-worker calls under the same account/zone.
      try {
        return await env.API.fetch(request)
      } catch (err) {
        return new Response(
          JSON.stringify({
            proxied: false,
            via: 'service-binding',
            error: err instanceof Error ? err.message : String(err),
          }),
          { status: 502, headers: { 'content-type': 'application/json' } },
        )
      }
    }

    return env.ASSETS.fetch(request)
  },
}
