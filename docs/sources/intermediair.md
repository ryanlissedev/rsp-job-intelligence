# Intermediair (intermediair.nl) — ingest-recept

Status: **probe afgerond; connector toegevoegd** — JSON-LD sitemap-index (CTP-550).

## Endpoints

| Doel | URL |
|---|---|
| Sitemap-index | `https://www.intermediair.nl/cdn/sitemaps/vacature.xml` |
| Vacature-sitemap (enige child) | `https://intermediair.nl/cdn/sitemaps/vacature/vacature-1.xml` |
| Detail | `https://www.intermediair.nl/vacature/<uuid>/<slug>` |

## Discovery

`kind: "sitemap-index"` met `newest: 1`: de index heeft één child
(`vacature-1.xml`) die elk uur volledig ververst wordt (2.480 URL's op
2026-09-17). De child-`<loc>` verwijst naar de non-www host; die redirecteert
naar `www.` en levert dezelfde payload. De vacature-URL's zelf zijn
`www.`+UUID+slug. `/vacature/zoeken?*` en `/vacatures/*?*page=` zijn
robots-disallowed; de sitemap-route is de enige compliant discovery.

## Veldmapping → canoniek `aanvraag`

| JSON-LD | Canoniek | Noot |
|---|---|---|
| `title` | `titel` | Letterlijk. |
| `description` | `beschrijving` | HTML in de bron (`<br>`, `<p>`). |
| `hiringOrganization.name` | `opdrachtgeverNaam` | Wisselende bemiddelaars (BAM, Matchpartner). |
| `jobLocation.address.addressLocality` | `locatieTekst` | `addressCountry` is `NL`. |
| `datePosted` | `bronSpecifiek.publicatiedatum` | ISO met tijd. |
| `validThrough` | `sluitingsdatum` | Aanwezig op alle samples. |
| `employmentType` | `bronSpecifiek.contract_type` | `FULL_TIME`/`PART_TIME`-array of `TEMPORARY`. |
| `baseSalary` | UNKNOWN | Slechts op een deel van de vacatures (`MonetaryAmount` EUR/month); anders letterlijk `null` in de JSON-LD. |
| `applicationContact`/`hiringOrganization.email` | — | Recruiter-e-mail (PII); niet gebruikt en uit de fixtures geredigeerd. |

## Robots, voorwaarden en fixtures

`robots.txt`: zoek-, paginatie- en accountpaden disallowed; detailpaden en de
gepubliceerde sitemaps niet → `voorwaardenStatus: te_toetsen`, `crawlDelayMs`
2000, `listingHashCoversDetail: false`. DPG Media serveert browser-UA's een
privacy-consent-redirect (`myprivacy.dpgmedia.nl/consent`); een aangemelde
bot-UA (`…compatible; JobIntelligenceBot/1.0`) krijgt de detailpagina direct.
`ClaudeBot` staat expliciet disallowed. Sinds 2026-10-11 stuurt live-fetch de
eerlijke User-Agent `NewonesJobIntelligence/<versie>` en nooit een ops-cookie;
of DPG die UA als bot-UA direct doorlaat of naar de consent-poort stuurt, is
nog niet live geverifieerd.

Fixtures: `tools/fixtures/record.ts`, standaardstrips. De drie detailpagina's
zijn opgenomen met de bot-UA omdat de fixture-UA op dezelfde privacy-poort
uitkomt (`--from-raw` op een reële capture).

## Voorwaarden

- robots.txt: www.intermediair.nl: HTTP 200, geen Disallow op connectorpaden (/cdn/sitemaps/, /vacature/0cad6431-f0e1-4d5a-9872-d4cba5ef0225/, /vacature/7fd25dd1-894d-4844-acf7-b5b672a10afc/, /vacature/f7184d95-36c8-4b0c-8a6d-c4054a749c39/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: zie "Robots, voorwaarden en fixtures" hierboven
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
