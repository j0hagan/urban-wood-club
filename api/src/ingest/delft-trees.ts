// Tier 1 ingestion: Delft's own managed-tree dataset ("Bomen in beheer door
// gemeente Delft"), pulled through the ArcGIS Hub v3 downloads API - the
// same endpoint the dataset page's own "Download > GeoJSON" button
// resolves to. Confirmed live (Sept 2026): returns real tree records with
// fields including BOOMSORTIMENT (species/cultivar), AANLEGJAAR (year
// planted), BUURT/WIJK (neighborhood/district).
//
// Dataset page: https://data.delft.nl/datasets/d83a50486b384bfe8038c2d762f5e628_0
// Item id used below: d83a50486b384bfe8038c2d762f5e628_0
//
// NOT resolved yet: no field was confirmed for "monumental tree" status,
// even though the dataset's own description mentions monumental trees are
// identified in it - is_monumental is left at 0 until the full field list
// is checked against a monumental-flagged record. BOOMSTATUS may carry a
// felled/removed state worth cross-referencing against Tier 2/3 data
// later - not used yet, don't assume its values without checking a live
// sample first.

const DOWNLOAD_URL =
  'https://hub.arcgis.com/api/v3/datasets/d83a50486b384bfe8038c2d762f5e628_0/downloads/data?format=geojson&spatialRefId=4326&where=1%3D1'

export interface DelftTreeRecord {
  id: string
  lat: number
  lon: number
  speciesNl: string | null
  sourceRef: string
}

interface GeoJsonTreeResponse {
  features: Array<{
    geometry: { coordinates: [number, number] } | null
    properties: Record<string, unknown>
  }>
}

export async function fetchDelftManagedTrees(): Promise<DelftTreeRecord[]> {
  const res = await fetch(DOWNLOAD_URL)
  if (!res.ok) throw new Error(`ArcGIS Hub download failed: ${res.status} ${res.statusText}`)
  const geojson = await res.json<GeoJsonTreeResponse>()

  return geojson.features
    .filter((f) => f.geometry?.coordinates?.length === 2)
    .map((f) => {
      const props = f.properties
      const ref = String(props.ID ?? props.OBJECTID)
      const [lon, lat] = f.geometry!.coordinates
      return {
        id: `delft-${ref}`,
        lat,
        lon,
        speciesNl: typeof props.BOOMSORTIMENT === 'string' ? props.BOOMSORTIMENT : null,
        sourceRef: ref,
      }
    })
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
  return res.json<{ elements: unknown[] }>()
}
