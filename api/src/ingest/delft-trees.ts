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
// Confirmed field formats (checked against a live sample, Sept 2026):
//   AANLEGJAAR  - clean 4-digit year
//   HOOGTE      - a band like "9-12 m." or "<6 m.", NOT a raw number
//   DIAMETER    - plain number (cm), frequently null
//   BOOMSTATUS  - null in every sample seen; not a felled/removed flag we
//                 can use (or maybe not populated for Delft specifically)
//   monumental  - no field name containing MONUMENT was found anywhere in
//                 the schema, despite the dataset's own description
//                 mentioning monumental trees - is_monumental stays 0
//                 until that's tracked down.

const DOWNLOAD_URL =
  'https://hub.arcgis.com/api/v3/datasets/d83a50486b384bfe8038c2d762f5e628_0/downloads/data?format=geojson&spatialRefId=4326&where=1%3D1'

export interface DelftTreeRecord {
  id: string
  lat: number
  lon: number
  speciesNl: string | null
  sourceRef: string
  plantedYear: number | null
  heightClass: string | null
  diameterCm: number | null
  neighborhood: string | null
  siteType: string | null
  managementGroup: string | null
  notes: string | null
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
      const str = (key: string) => (typeof props[key] === 'string' && props[key] !== '' ? (props[key] as string) : null)
      const num = (key: string) => (typeof props[key] === 'number' ? (props[key] as number) : null)
      const notes = [str('EXTRA_INFORMATIE_2'), str('EXTRA_INFORMATIE_3')].filter(Boolean).join(' ') || null

      return {
        id: `delft-${ref}`,
        lat,
        lon,
        speciesNl: str('BOOMSORTIMENT'),
        sourceRef: ref,
        plantedYear: num('AANLEGJAAR'),
        heightClass: str('HOOGTE'),
        diameterCm: num('DIAMETER'),
        neighborhood: str('BUURT'),
        siteType: str('STANDPLAATS'),
        managementGroup: str('BEHEERGROEP'),
        notes,
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
