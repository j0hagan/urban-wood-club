import csv, json, os

SPECIES_EN = {
    'Gewone es': 'Common ash',
    'Witte paardekastanje': 'Horse chestnut',
    'Canadapopulier': "Canadian poplar",
    'Hollandse iep': 'Dutch elm',
    'Gewone esdoorn': 'Sycamore maple',
    'Hollandse linde': 'Common lime',
    'Japanse sierkers': 'Japanese flowering cherry',
    'Boomhazelaar': 'Turkish hazel',
    'Zwarte els': 'Black alder',
    'Krimlinde': 'Crimean lime',
    'Zoete kers': 'Wild cherry',
    'Spaeth els': "Spaeth's alder",
    'Iep': 'Elm',
    'Valse christusdoorn': 'Honey locust',
    'Noorse esdoorn': 'Norway maple',
    'Sierappel': 'Ornamental crabapple',
    'Sierpeer': 'Ornamental pear',
    'Beverboom': 'Kobushi magnolia',
    'Lijsterbes': 'Rowan',
    'Zomerlinde': 'Large-leaved lime',
    'Zweedse lijsterbes': 'Swedish whitebeam',
    'Amberboom': 'Sweetgum',
    'Niet in lijst': None,
    'Hybride lijsterbes': 'Hybrid whitebeam',
    'Pluimes': 'Manna ash',
    'Meelbes': 'Whitebeam',
    'Zilveresdoorn': 'Silver maple',
    'Honingboom': 'Japanese pagoda tree',
    'Zomereik': 'English oak',
    'Winterbloeiende kers': 'Autumn cherry',
    'Wolappel': 'Tschonoski crabapple',
    'Smalbladige es': 'Narrow-leaved ash',
    'Consumpieappel': 'Domestic apple',
    'Consumptieappel': 'Domestic apple',
    'Schietwilg': 'White willow',
    'Ruwe berk': 'Silver birch',
    'Eenstijlige meidoorn': 'Common hawthorn',
    'Moerascipres': 'Swamp cypress',
    'Amerikaanse es': 'White ash',
    'Veldesdoorn': 'Field maple',
    'Tamme kastanje': 'Sweet chestnut',
    'Valse acacia': 'Black locust',
    'Hybride meidoorn': 'Hybrid hawthorn',
    'Zwarte berk': 'River birch',
    'Goudiep': 'Golden elm',
    'Gele treurwilg': 'Golden weeping willow',
    'Zachte berk': 'Downy birch',
    'Witte Himalayaberk': 'Himalayan birch',
    'Kronkelwilg': "Corkscrew willow",
    'Mantsjoerije kers': 'Manchurian cherry',
    'Mantsjoerijse kers': 'Manchurian cherry',
    'Witte moerbei': 'White mulberry',
    'Gewone beuk': 'European beech',
    'Moeraseik': 'Pin oak',
    'Ratelpopulier': 'European aspen',
    'Amerikaanse linde': 'American basswood',
    'Haagbeuk': 'Common hornbeam',
    'Europese vogelkers': 'European bird cherry',
    'Krentenboompje': 'Serviceberry',
    'Grauwe abeel': 'Grey poplar',
}

GENUS_EN = {
    'Fraxinus': 'Ash', 'Aesculus': 'Horse chestnut', 'Populus': 'Poplar',
    'Ulmus': 'Elm', 'Acer': 'Maple', 'Tilia': 'Lime', 'Corylus': 'Hazel',
    'Alnus': 'Alder', 'Prunus': 'Cherry', 'Gleditsia': 'Honey locust',
    'Malus': 'Crabapple', 'Pyrus': 'Pear', 'Magnolia': 'Magnolia',
    'Sorbus': 'Whitebeam/Rowan', 'Liquidambar': 'Sweetgum',
    'Quercus': 'Oak', 'Styphnolobium': 'Pagoda tree', 'Salix': 'Willow',
    'Betula': 'Birch', 'Crataegus': 'Hawthorn', 'Taxodium': 'Cypress',
    'Castanea': 'Chestnut', 'Robinia': 'Locust', 'Morus': 'Mulberry',
    'Fagus': 'Beech', 'Carpinus': 'Hornbeam', 'Amelanchier': 'Serviceberry',
}

NA_PLACEHOLDER = 'N.v.t. (boom niet aanwezig)'

TREE_SIZE_EN = {
    '1e grootte': '1st size class (large)',
    '2e grootte': '2nd size class (medium)',
    '3e grootte': '3rd size class (small)',
    'Niet bepaald': None,
    'Volledige lijst': None,
    NA_PLACEHOLDER: None,
}

CONDITION_EN = {
    'Zeer slecht': 'Very poor',
    'Slecht': 'Poor',
    'Onvoldoende': 'Insufficient',
    'Voldoende': 'Sufficient',
    'Goed': 'Good',
    NA_PLACEHOLDER: None,
}

def size_band(value: str):
    # "50 tot 100 cm" / "12 tot 18 m" -> "50-100 cm" / "12-18 m" - the raw
    # Dutch bands are otherwise already just numbers + units, so a light
    # readability pass ('tot' -> '-') is enough without a real translation.
    v = value.strip()
    if not v or v == NA_PLACEHOLDER:
        return None
    return v.replace(' tot ', '-')

def int_or_none(value: str):
    v = value.strip()
    try:
        return int(float(v))
    except ValueError:
        return None

def strip_cv(nl_name: str) -> str:
    name = nl_name.strip()
    if name.endswith(' CV.'):
        name = name[:-4].strip()
    return name

def species_en_for(nl_name: str, lat_name: str):
    if not nl_name or nl_name == 'Niet in lijst':
        return None
    base = strip_cv(nl_name)
    if base in SPECIES_EN:
        return SPECIES_EN[base]
    genus = lat_name.split()[0] if lat_name else ''
    return GENUS_EN.get(genus)

with open('bomen_delft_2026.csv', encoding='utf-8-sig') as f:
    reader = csv.DictReader(f)
    rows = list(reader)

photo_files_key = [k for k in rows[0].keys() if 'fotobestanden' in k.lower()][0]

records = []
unmapped_species = set()
for row in rows:
    grib_id = row['GRIB id'].strip()
    boomnummer = row['Boomnummer'].strip() or None

    nl_raw = row['Soort (NL)'].strip()
    lat_raw = row['Soort (wetenschappelijk)'].strip()
    label = row['Soort (viewer-label)'].strip()
    if nl_raw == 'N.v.t. (boom niet aanwezig)':
        if '(' in label and label.endswith(')'):
            nl = label.split('(')[0].strip()
            lat = label[label.index('(') + 1:-1].strip()
        else:
            nl, lat = (label or None), (label or None)
    else:
        nl, lat = (nl_raw or None), (lat_raw or None)

    en = species_en_for(nl, lat) if nl else None
    if nl and en is None and nl != 'Niet in lijst':
        unmapped_species.add((nl, lat))

    try:
        latf = float(row['Latitude (WGS84)'])
        lonf = float(row['Longitude (WGS84)'])
    except (ValueError, KeyError):
        latf = lonf = None

    aanwezigheid = row['Aanwezigheid'].strip()
    already_felled = aanwezigheid in ('Boom niet aanwezig', 'Alleen stobbe aanwezig')

    ff = row[photo_files_key].strip()
    names = [x.strip() for x in ff.split(';') if x.strip()] if ff else []
    has_photo = bool(names) and os.path.exists(os.path.join('processed_photos', f'{grib_id}.jpg'))

    neighborhood = row['Buurt'].strip() or row['Wijk'].strip() or None

    condition_nl = row['Conditie'].strip()
    tree_size_nl = row['Boomgrootte'].strip()

    records.append({
        'grib_id': grib_id,
        'boomnummer': boomnummer,
        'species_nl': nl,
        'species_lat': lat,
        'species_en': en,
        'lat': latf,
        'lon': lonf,
        'address': row['Straat'].strip() or None,
        'neighborhood': neighborhood,
        'requires_permit': row['Vergunningsplicht'].strip() == 'Kapvergunningsplichtig',
        'already_felled': already_felled,
        'presence_status': aanwezigheid or None,
        'reason_nl': row['Reden vellen'].strip() or None,
        'planted_year': int_or_none(row['Plantjaar']),
        'age_years': int_or_none(row['Leeftijd (jr, per 2026)']),
        'trunk_diameter_class': size_band(row['Stamdiameterklasse']),
        'height_class': size_band(row['Hoogteklasse']),
        'tree_size_class': TREE_SIZE_EN.get(tree_size_nl, tree_size_nl or None),
        'condition_nl': condition_nl if condition_nl and condition_nl != NA_PLACEHOLDER else None,
        'condition_en': CONDITION_EN.get(condition_nl, condition_nl or None),
        'has_photo': has_photo,
        'photo_filename': f'{grib_id}.jpg' if has_photo else None,
    })

print('total records', len(records))
print('with lat/lon', sum(1 for r in records if r['lat'] is not None))
print('with photo', sum(1 for r in records if r['has_photo']))
print('requires_permit True', sum(1 for r in records if r['requires_permit']))
print('already_felled True', sum(1 for r in records if r['already_felled']))
print('unmapped species (nl, lat):', len(unmapped_species))
for u in sorted(unmapped_species):
    print(' ', u)

with open('import_records.json', 'w', encoding='utf-8') as f:
    json.dump(records, f, ensure_ascii=False, indent=1)
print('wrote import_records.json')
