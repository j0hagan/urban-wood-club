interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> }
}

const API_ORIGIN = 'https://urban-wood-club-api.urban-wood-clubworkersdev.workers.dev'

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
      const target = new URL(url.pathname + url.search, API_ORIGIN)

      // Strip headers that describe the ORIGINAL (frontend) request but must
      // not be forwarded to a different origin: Host in particular can make
      // Cloudflare's edge misroute the subrequest back to this same worker
      // instead of the API worker.
      const proxyHeaders = new Headers(request.headers)
      proxyHeaders.delete('host')
      proxyHeaders.delete('cf-connecting-ip')
      proxyHeaders.delete('cf-ray')

      try {
        const init: RequestInit = {
          method: request.method,
          headers: proxyHeaders,
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          init.body = request.body
        }
        const resp = await fetch(target.toString(), init)

        // Surface what actually happened if it's not a success, instead of
        // silently passing through an opaque 404/5xx.
        if (!resp.ok) {
          const bodyText = await resp.text()
          return new Response(
            JSON.stringify({
              proxied: true,
              target: target.toString(),
              upstreamStatus: resp.status,
              upstreamBody: bodyText.slice(0, 500),
            }),
            { status: resp.status, headers: { 'content-type': 'application/json' } },
          )
        }

        return resp
      } catch (err) {
        return new Response(
          JSON.stringify({
            proxied: false,
            target: target.toString(),
            error: err instanceof Error ? err.message : String(err),
          }),
          { status: 502, headers: { 'content-type': 'application/json' } },
        )
      }
    }

    return env.ASSETS.fetch(request)
  },
}
