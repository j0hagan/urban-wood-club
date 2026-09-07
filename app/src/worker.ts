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
      try {
        const init: RequestInit = {
          method: request.method,
          headers: request.headers,
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          init.body = request.body
        }
        return await fetch(target.toString(), init)
      } catch (err) {
        return new Response(
          'Proxy error: ' + (err instanceof Error ? err.message : String(err)),
          { status: 502 },
        )
      }
    }

    return env.ASSETS.fetch(request)
  },
}
