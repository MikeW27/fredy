/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * ImmoScout24.ch provider for Fredy
 *
 * ImmoScout24.ch (SMG Swiss Marketplace Group) is a completely separate company
 * from ImmoScout24.de (Scout24 SE). They share no code, APIs, or infrastructure.
 *
 * The site runs on Next.js and server-side renders all listing data into the
 * `<script id="__NEXT_DATA__">` tag embedded in every page. Reading that JSON
 * is far more stable than scraping the markup and requires no external services.
 *
 * The provider uses Fredy's shared Puppeteer browser to render each search page
 * (bypassing DataDome's bot detection the same way the other Puppeteer-based
 * providers do) and then extracts the listings from the embedded JSON payload.
 */

import { buildHash, isOneOf, nullOrEmpty, sleep } from '../utils.js';
import puppeteerExtractor from '../services/extractor/puppeteerExtractor.js';
import * as cheerio from 'cheerio';
import { extractNumber } from '../utils/extract-number.js';
import logger from '../services/logger.js';
/** @import { ParsedListing } from '../types/listing.js' */
/** @import { ProviderConfig } from '../types/providerConfig.js' */

/** How many result pages one run reads at most to avoid infinite crawls. */
const MAX_PAGES = 5;

/**
 * Delay between page requests (milliseconds).
 *
 * DataDome measures request cadence; a short pause keeps the session from
 * looking like a bot on page transitions.
 */
const PAGE_DELAY_MS = 2_000;
const PAGE_JITTER_MS = 1_500;

/** The query parameter immoscout24.ch uses for pagination. */
const PAGE_PARAM = 'pn';

/**
 * Parse the `__NEXT_DATA__` script tag out of a rendered HTML page and return
 * the decoded JavaScript object it contains.
 *
 * @param {string|null|undefined} html Raw HTML of a search result page.
 * @returns {any|null} Parsed Next.js payload, or null when absent / malformed.
 */
export function parseNextData(html) {
  if (!html) return null;
  const raw = cheerio.load(html)('script#__NEXT_DATA__').first().text();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Extract the listing array and total page count from a parsed Next.js payload.
 *
 * immoscout24.ch stores the search result inside
 * `pageProps.searchResult.resultList.resultListEntry` and the page count inside
 * `pageProps.searchResult.resultList.paging`.
 *
 * @param {any} nextData Parsed Next.js payload from {@link parseNextData}.
 * @returns {{listings: any[], totalPages: number}|null} Listings and page count,
 *   or null when the payload does not contain the expected structure.
 */
export function parseListings(nextData) {
  const resultList = nextData?.props?.pageProps?.searchResult?.resultList;
  if (resultList == null) return null;

  const entries = resultList.resultListEntry;
  if (!Array.isArray(entries)) return null;

  // entries can mix listing objects with ad/banner objects; keep only real listings
  const listings = entries
    .map((entry) => entry?.resultEntry?.listing ?? entry?.listing)
    .filter(Boolean);

  const totalPages = Number(resultList.paging?.numberOfPages) || 1;
  return { listings, totalPages };
}

/**
 * Build a URL that addresses a specific result page.
 *
 * Page 1 is left as the user typed it (the original URL without any paging
 * parameter), so the job form URL remains the canonical reference.
 *
 * @param {string} url The base search URL.
 * @param {number} page 1-indexed page number.
 * @returns {string} The URL for that page.
 */
export function pageUrl(url, page) {
  const parsed = new URL(url);
  if (page > 1) {
    parsed.searchParams.set(PAGE_PARAM, String(page));
  } else {
    parsed.searchParams.delete(PAGE_PARAM);
  }
  return parsed.toString();
}

/**
 * Fetch all result pages of a search using the shared Puppeteer browser.
 *
 * Called with `this` bound to {@link FredyPipelineExecutioner} — the same
 * convention as every other provider that defines a custom `getListings`.
 *
 * @this {import('../FredyPipelineExecutioner.js').FredyPipelineExecutioner}
 * @param {string} url The search URL the user pasted into the job form.
 * @param {import('puppeteer').Browser} browser The shared browser of this run.
 * @returns {Promise<any[]>} Raw listing objects from all fetched pages.
 */
async function getListings(url, browser) {
  const allListings = [];
  const seen = new Set();

  /**
   * Options passed to every puppeteerExtractor call for this provider.
   *
   * DataDome (the bot protection on immoscout24.ch) fingerprints the browser
   * session across several dimensions. The most telling signals for a Swiss
   * site are the Accept-Language header and the timezone: a German browser
   * (de-DE, Europe/Berlin) visiting immoscout24.ch is a strong mismatch.
   * Setting Swiss-German locale and Europe/Zurich removes that signal.
   *
   * `preNavigateUrl` makes the browser visit the homepage first, so the
   * session has a navigation history before the search page is loaded.
   * DataDome is more lenient with sessions that look like they browsed in.
   */
  const extractorOptions = {
    browser,
    name: 'immoscout24ch',
    acceptLanguage: 'de-CH,de;q=0.9,en;q=0.7',
    timezone: 'Europe/Zurich',
    preNavigateUrl: 'https://www.immoscout24.ch/',
    waitUntil: 'networkidle2',
  };

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1) {
      await sleep(PAGE_DELAY_MS + Math.random() * PAGE_JITTER_MS);
    }

    const fetchUrl = pageUrl(url, page);
    // The homepage warm-up only needs to happen once — on the first page.
    // Subsequent pages reuse the same browser session which is already established.
    const pageOptions = page === 1 ? extractorOptions : { ...extractorOptions, preNavigateUrl: undefined };
    const html = await puppeteerExtractor(fetchUrl, 'body', pageOptions);

    const nextData = parseNextData(html);
    const result = parseListings(nextData);

    if (result == null) {
      if (page === 1) {
        logger.error(
          'ImmoScout24.ch: Search page did not contain the expected __NEXT_DATA__. ' +
            'The search URL may be wrong or the site structure has changed.',
        );
      }
      break;
    }

    const fresh = result.listings.filter((listing) => {
      const id = listing?.id;
      return id != null && !seen.has(id);
    });
    for (const listing of fresh) seen.add(listing.id);
    allListings.push(...fresh);

    logger.info(
      `ImmoScout24.ch: Page ${page}/${Math.min(result.totalPages, MAX_PAGES)} — ` +
        `${fresh.length} listings (${allListings.length} total so far)`,
    );

    // Stop when we have read the last page or hit the cap.
    if (page >= Math.min(result.totalPages, MAX_PAGES)) {
      if (result.totalPages > MAX_PAGES) {
        logger.warn(
          `ImmoScout24.ch: Stopped after ${MAX_PAGES} pages. Narrow the search to see all results.`,
        );
      }
      break;
    }
  }

  return allListings;
}

/**
 * Build the price string from the listing's price object.
 *
 * immoscout24.ch distinguishes rent (`rent.gross`) and purchase (`buy.price`)
 * and reports amounts as numeric strings.
 *
 * @param {any} prices The `prices` object from the raw listing.
 * @returns {string} Human-readable price, or empty string when not available.
 */
function buildPriceString(prices) {
  if (prices == null) return '';
  if (prices.rent?.gross) {
    const suffix = prices.rent.interval === 'MONTH' ? '/Mt.' : '';
    return `CHF ${prices.rent.gross}${suffix}`;
  }
  if (prices.buy?.price) {
    return `CHF ${prices.buy.price}`;
  }
  return '';
}

/**
 * Build the size string from the listing's characteristics.
 *
 * @param {any} characteristics The `characteristics` object from the raw listing.
 * @returns {string} e.g. "4.5 Zimmer, 120 m²", or empty string.
 */
function buildSizeString(characteristics) {
  if (characteristics == null) return '';
  const parts = [];
  if (characteristics.numberOfRooms != null) {
    parts.push(`${characteristics.numberOfRooms} Zimmer`);
  }
  if (characteristics.livingSpace != null) {
    parts.push(`${characteristics.livingSpace} m²`);
  }
  return parts.join(', ');
}

/**
 * Build the address string from the listing's address object.
 *
 * @param {any} address The `address` object from the raw listing.
 * @returns {string} e.g. "Musterstrasse 1, 8001 Zürich", or empty string.
 */
function buildAddressString(address) {
  if (address == null) return '';
  const parts = [];
  if (address.street) parts.push(address.street);
  const locality = [address.postalCode, address.locality].filter(Boolean).join(' ');
  if (locality) parts.push(locality);
  return parts.join(', ');
}

/**
 * Build the listing detail-page URL from the listing's id and offer type.
 *
 * @param {string|number} id The listing's id.
 * @param {string|undefined} offerType The raw offer type ("BUY" or "RENT").
 * @returns {string} The absolute URL on immoscout24.ch.
 */
function buildLink(id, offerType) {
  const type = offerType === 'BUY' ? 'buy' : 'rent';
  return `https://www.immoscout24.ch/${type}/${id}`;
}

/**
 * Normalise a raw listing object into the shape the Fredy pipeline expects.
 *
 * @param {any} o Raw listing object as returned by {@link getListings}.
 * @returns {ParsedListing}
 */
function normalize(o) {
  // Localisation: the listing carries a `localization` map keyed by language code.
  const localization = o.localization ?? {};
  const lang = localization.primary ?? 'de';
  const localised = localization[lang] ?? localization.de ?? {};
  const text = localised.text ?? {};
  const attachments = localised.attachments ?? [];

  const characteristics = o.characteristics ?? {};
  const prices = o.prices ?? {};
  const address = o.address ?? {};

  const listingId = o.id;
  const priceStr = buildPriceString(prices);

  // The image comes from the first attachment of type IMAGE.
  const imageAttachment = attachments.find((a) => a?.type === 'IMAGE');

  return {
    id: buildHash(String(listingId), priceStr),
    title: nullOrEmpty(text.title) ? 'NO TITLE FOUND' : text.title.trim(),
    description: text.description?.trim() ?? '',
    price: priceStr,
    size: buildSizeString(characteristics),
    rooms: extractNumber(characteristics.numberOfRooms),
    address: nullOrEmpty(buildAddressString(address)) ? 'NO ADDRESS FOUND' : buildAddressString(address),
    latitude: extractNumber(address.geoCoordinates?.latitude),
    longitude: extractNumber(address.geoCoordinates?.longitude),
    link: buildLink(listingId, o.offerType),
    image: imageAttachment?.url ?? null,
  };
}

/**
 * Apply the job's blacklist to a listing.
 *
 * @param {ParsedListing} o The normalised listing.
 * @param {string[]} blacklist Terms that disqualify a listing.
 * @returns {boolean} `true` when the listing is NOT blacklisted.
 */
function applyBlacklist(o, blacklist) {
  return !isOneOf(o.title, blacklist) && !isOneOf(o.description, blacklist);
}

/** @type {ProviderConfig} */
const config = {
  url: null,
  // immoscout24.ch has no public URL sort parameter — the URL is passed through
  // unchanged. The site sorts by relevance by default; listing deduplication via
  // hash handles re-runs without a date sort.
  sortByDateParam: null,
  requiredFieldNames: ['id', 'link', 'title', 'price', 'address'],
  // The listings are read from __NEXT_DATA__, not from the markup.
  crawlContainer: null,
  crawlFields: {},
  getListings,
  normalize,
};

/**
 * Build a run-scoped provider configuration.
 *
 * Returns a fresh object on every call rather than mutating module-level state.
 * Two jobs can be in flight at once — a manual run while the scheduler is
 * working — and shared mutable state would let the second job overwrite the
 * first job's URL and blacklist mid-run.
 *
 * @param {{url: string, enabled?: boolean}} sourceConfig The job's entry for this provider.
 * @param {string[]} [blacklist] Terms to filter listings out by.
 * @returns {ProviderConfig} A configuration usable by a single pipeline run.
 */
export const createConfig = (sourceConfig, blacklist = []) => ({
  ...config,
  enabled: sourceConfig.enabled,
  url: sourceConfig.url,
  filter: (listing) => applyBlacklist(listing, blacklist),
});

/** @type {import('../types/providerConfig.js').ProviderMetaInformation} */
export const metaInformation = {
  name: 'ImmoScout24.ch',
  baseUrl: 'https://www.immoscout24.ch/',
  id: 'immoscout24ch',
  countries: ['ch'],
};

export { config };