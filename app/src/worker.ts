interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> }
}

const API_ORIGIN = 'https://urban-wood-club-api.urban-wood-clubworkersdev.workers.dev'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) {
      const target = new URL(url.pathname + url.search, API_ORIGIN)
      return fetch(new Request(target.toString(), request))
    }
    return env.ASSETS.fetch(request)
  },
}
