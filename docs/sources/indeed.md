# Indeed NL (`nl.indeed.com`)

- **Slug**: `indeed` · **bronId**: `00000000-0000-4000-8000-000000000044`
- **Naam**: Indeed · **liveEnv**: `INDEED_LIVE` (het `INDEED_COOKIE`-pad is
  per 2026-10-11 verwijderd; geen cf_clearance-cookies meer) · **methode**: `html_parser`
- **voorwaardenStatus**: `te_toetsen` — zie "Juridisch" onderaan.
- **Issue**: CTP-540. PoC-context: `inventory/browser-poc-wave.md`
  (2026-09-18) en de wave-docs die de route-keuze "managed data-API (Apify)"
  voorspelden.

## Status: connector + parser gebouwd, live-pad bevestigd geblokkeerd op deze host

Probe 2026-09-18 vanaf deze egress (exacte statussen, `curl` mét browser-UA +
`indeed_rcc`-consent-cookie, en identiek via Bun `fetch`):

| URL | Status | Inhoud |
|---|---|---|
| `GET /` | **403** | Cloudflare managed challenge, `cf-mitigated: challenge` |
| `GET /jobs?q=developer&l=Nederland` | **403** | idem (27.865 bytes interstitial) |
| `GET /jobs?…&from=serp` | **403** | idem |
| `GET /jobs?…&rss=1`, `?format=rss` | **403** | idem |
| `GET /viewjob?jk=<id>` | **401** | "Authenticating…" pagina die via JS naar `secure.indeed.com/auth?…&from=bot-detection-anonymous` redirecteert (login-muur) |
| `GET /cmp/bol.com` | **403** | challenge |
| `GET /robots.txt` | 200 | bevat geen sitemap-verwijzing |
| `GET /sitemap.xml` | 404 | — |
| `m.indeed.com` | DNS NXDOMAIN | — |

Daarna **headed Chrome** (`agent-browser --headed`, NL-egress, géén stealth/
solver/proxy — buiten scope): **één schone load** van
`/jobs?q=developer&l=Nederland` met 15 echte kaarten + volledige embedded
data. De tweede navigatie (`start=10`) leverde meteen de
"Security Check"-turnstile en `/viewjob?jk=` de login-muur — exact wat de
browser-PoC al voorspelde ("sessies degraderen snel").

## Route — publieke SERP, data uit embedded state

De server-renderde zoekpagina embeddeert alles wat we nodig hebben als
JS-assignments in `<script>`-blokken:

- **Listing**: `window.mosaic.providerData["mosaic-provider-jobcards"]`
  → `.metaData.mosaicProviderJobCardsModel.results[]` — 15 kaarten op de
  capture (alle 15 `sponsored: true` op pagina 1; het veld bestaat wel, dus
  de mix kan per pagina verschillen).
- **Paginatie**: `window._initialData.pageLinks[]` — labels + hrefs
  (`…&start=10`, `=20`, …; stride 10 terwijl een pagina 15 kaarten draagt).
  `searchTitleBarModel.totalNumResults` = 2.090 op de capture. De connector
  volgt `pageLinks[label === pageNum + 1].start`, verzint geen stride.
- **Detail**: `_initialData.autoOpenTwoPaneViewjobResponse.body` — een
  volledige viewjob-payload voor de auto-geopende kaart (op de capture
  `from: "tp-sponfirstjob"`, de eerste gesponsorde kaart): o.a.
  `jobInfoWrapperModel.jobInfoModel.sanitizedJobDescription` (volledige
  beschrijving, 5.195 chars), `jobInfoHeaderModel` (companyName, jobTitle,
  formattedLocation, remoteWorkModel), `salaryInfoModel`, `jobOccupations`,
  `jobMetadataFooterModel.age`.

`GET /viewjob?jk=` is login-gated — ook in een echte browser — dus de detail
publieke detaildata komt uit die embedded body. Live probeert de client
`/jobs?…&vjk=<jobkey>` (de parameter die de browser zelf zette toen de kaart
auto-opende); **ongeverifieerd** of een willekeurige `vjk` server-side de
gevraagde body embeddeert. `parseIndeedJobPosting` (JobPosting
`application/ld+json` voor het geval `/viewjob` ooit weer anoniem HTML
serveert) is geschreven maar **ongetest tegen live data** — er bestaat geen
capture van die route.

## Veldafdekking (payload → draft)

| Draft | Bronpad |
|---|---|
| titel | `detail.jobTitle` → `card.title` → `displayTitle`/`normTitle` |
| beschrijving | `detail.sanitizedJobDescription` (stripHtml + entities) → `card.snippet` → titel |
| bronReferentie | `jobkey` (hex, bv. `12c9e91e86a09037`) |
| bronUrl | `https://nl.indeed.com/viewjob?jk=<jobkey>` — canoniek, tracking-params uit `viewJobLink` gedropped |
| opdrachtgeverNaam | `detail.companyName` → `card.company` |
| locatieTekst | `detail.formattedLocation` → `card.formattedLocation` |
| locatieLand | `card.country` ("NL" op de capture) → `"NL"` |
| tarief | `detail.salaryInfoModel` → `card.extractedSalary`; `HOURLY`→uur, `DAILY`→dag, `MONTHLY`→maand. **`YEARLY` en onbekende types blijven UNKNOWN** (jaarsalaris naar maand rekenen = verzonnen); ruwe min/max/type/tekst landen in `bronSpecifiek` |
| lifecycle | `card.expired === true` → `closed` (eigen bronvlag); verder `active` |
| startDatum | **UNKNOWN — afwezig bij de bron** |
| sluitingsdatum | **afwezig — Indeed publiceert geen deadline** |
| contactpersonen | **afwezig** — anoniem oppervlak publiceert geen contactpersoon |
| uren/week | **afwezig** — alleen `jobTypes`-labels ("Fulltime"/"Parttime"), geen urenaantal |
| bronSpecifiek | `salaris_*` (min/max/type/tekst), `dienstverband_labels`, `remote(_type)`, `bedrijf_rating`/`_beoordelingen`, `gepubliceerd_op` (pubDate ms→ISO), `relatieve_datum`, `gesponsord`, `urgent`, `vacatures_in_rol`, `vereisten_labels`, `functie_categorieen`, `stad`, `staat_code`, `provincie`, `indeed_apply` |

## listingHashCoversDetail = false

De listing-hash dekt alle whitelisted kaartvelden (coverage-test in
`indeed.spec.ts`), maar `sanitizedJobDescription`, `salaryInfoModel` en
`jobOccupations` zitten alleen in de detail-payload — de hash kan
detail-wijzigingen niet zien, dus `knownHashes` wordt niet geconsulteerd
(zelfde redenering als werk-nl, RJC-357/RJC-401).

## Fixtures — echte captures, eerlijke dekkingsgraad

- `fixtures/connectors/indeed/listing-page-0.json` — echte headed-Chrome
  capture van `/jobs?q=developer&l=Nederland` (2026-09-18, mtime-gebaseerde
  `capturedAt`). Mechanisch getrimd (`record.ts --no-defaults`): styles, svg,
  nav/footer/form/aside, `script[src]`, init/config-scripts
  (`#mosaic-init-data`, `#_indeed_gnav_config`, translation overrides)
  verwijderd; de datadragende inline scripts
  (`window._initialData`, `mosaic.providerData`) en de kaart-DOM behouden.
  6 e-mailadressen geredacteerd door de recorder.
- `blocked-search-challenge.json` — verbatim 403-challenge (curl).
- `blocked-viewjob-authenticating.json` — verbatim 401 "Authenticating…".
- `blocked-security-check.json` — verbatim headed-browser turnstile
  (DOM-dump van de tweede navigatie).

**Dekkingsgraad**: de listing-fixture embeddeert precies één viewjob-body
(jk `12c9e91e86a09037`). `fetch()` op de andere 14 kaarten → `rejected`
("no anonymous viewjob payload published for jk …"). Dat is bewust streng:
een card-only body zou de snippet als volledige beschrijving laten
doorgaan en een stilletjes stuk detail-pad onzichtbaar maken in run-metrics.

## Wat er nodig is voor live polling

Plain HTTP vanaf deze host is onbruikbaar (zie statustabel). Minimaal nodig:

1. **NL-egress + echte-browser TLS/JA3** (headed-Chrome host, bv. de
   agent-browser PoC-route) of een managed data-API (Apify, zoals CTP-540 al
   koos) — géén stealth-fingerprint/proxy-rotatie/solvers in deze connector.
2. `INDEED_LIVE=1`. Het vroegere `INDEED_COOKIE`-pad (cf_clearance uit een
   geconsenteerde sessie) is verwijderd: de connector stuurt alleen de eerlijke
   User-Agent `NewonesJobIntelligence/<versie>` en geen clearance-cookies.
3. Verificatie van `?vjk=<jk>` server-side embedding (nu ongetest); anders
   één SERP-reload per kaart of de Apify-actor die detaildata levert.

Een geblokkeerde pagina gooit een error (`isIndeedBlockedPage` op body-markers
+ `cf-mitigated`), nooit een lege listing — een challenge mag geen
"bron is leeg" reconciliatie triggeren.

## Juridisch

ToS/robots: `robots.txt` staat `/jobs` crawlen formeel toe voor `*`, maar de
ToS-verklaring en de "route: Apify"-beslissing op CTP-540 blijven leidend —
`te_toetsen` tot een juridische GO ligt. De browser-PoC was expliciet
technisch-bewijs, geen autorisatie.

## Voorwaarden

- robots.txt: nl.indeed.com: HTTP 200, geen Disallow op connectorpaden (/), geprobed 2026-09-25
- ToS/gebruiksvoorwaarden: zie "Juridisch" hierboven
- Besluit: `te_toetsen`
- Besluitnemer en datum: open voor Robbie (geen besluit vastgelegd)
