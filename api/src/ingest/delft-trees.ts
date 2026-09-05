// Tier 1 ingestion: Delft's own managed-tree dataset ("Bomen in beheer door
// gemeente Delft"), published as open GIS data on an Esri ArcGIS Hub site.
//
// Dataset page: https://data.delft.nl/datasets/d83a50486b384bfe8038c2d762f5e628_0
//
// Esri Hub dataset pages expose a standard ArcGIS REST FeatureServer/query
// endpoint. Grab the exact URL from that page's "API" / "View API Resource"
// link (it wasn't extractable from a plain page fetch during research) -
// it'll look like:
//   https://services.arcgis.com/<org>/arcgis/rest/services/<layer>/FeatureServer/0
// Once you have it, paste it in as FEATURE_SERVER_QUERY_URL below.

const FEATURE_SERVER_QUERY_URL = '' // TODO: fill in from the dataset's API link

export async function fetchDelftManagedTrees() {
  if (!FEATURE_SERVER_QUERY_URL) {
    throw new Error('FEATURE_SERVER_QUERY_URL not set - see comment at top of this file')
  }
  const results: any[] = []
  let offset = 0
  const pageSize = 2000
  for (;;) {
    const url =
      `${FEATURE_SERVER_QUERY_URL}/query?where=1%3D1&outFields=*&f=geojson` +
      `&resultOffset=${offset}&resultRecordCount=${pageSize}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`ArcGIS query failed: ${res.status}`)
    const geojson = await res.json<{ features: any[] }>()
    results.push(...geojson.features)
    if (geojson.features.length < pageSize) break
    offset += pageSize
  }
  return results
}

// Tier 1b (complementary/cross-check): OpenStreetMap tree tags via
// Overpass. openbomenkaart.org renders this same underlying OSM data with
// Leaflet - useful as a visual reference, but pull the data directly here
// rather than scraping that page.
const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter'

export async function fetchDelftOsmTrees() {
  const query = `
    [out:json][timeout:60];
    area["name"="Delft"]["boundary"="administrative"]->.a;
    node["natural"="tree"](area.a);
    out body;
  `
  const res = await fetch(OVERPASS_ENDPOINT, { method: 'POST', body: query })
  if (!res.ok) throw new Error(`Overpass query failed: ${res.status}`)
  return res.json<{ elements: any[] }>()
}
