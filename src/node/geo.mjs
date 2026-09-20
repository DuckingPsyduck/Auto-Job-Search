/**
 * Location classification and ranking.
 *
 * Rule (see docs/DECISIONS.md): a location counts as domestic only on POSITIVE evidence — a
 * state, the country name, a known city, or a recognised pattern. Anything unrecognised is
 * "check", never assumed domestic. This is what keeps foreign cities off a domestic shortlist.
 *
 * Term lists live in config/geo-terms.json so a new place can be added once and picked up by
 * both the Node and Python pipelines. Home-state rules come from the profile.
 */
import { readFileSync } from 'node:fs';

/** @typedef {'yes'|'no'|'check'} Domestic */

const words = list => new RegExp(String.raw`\b(${list.join('|')})\b`, 'i');
const US_STATE_NAMES = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado',
  CT: 'connecticut', DE: 'delaware', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho',
  IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana',
  ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota',
  MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada',
  NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york', NC: 'north carolina',
  ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania',
  RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas',
  UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia',
  WI: 'wisconsin', WY: 'wyoming', DC: 'district of columbia', PR: 'puerto rico',
};

export class Geo {
  /**
   * @param {object} terms parsed config/geo-terms.json
   * @param {object} [options]
   * @param {string} [options.homeState] two-letter code; on-site there ranks last
   * @param {string[]} [options.homeStateCities] extra city names that mean the home state
   */
  constructor(terms, { homeState = '', homeStateCities = [] } = {}) {
    const knownCities = terms.state_cities?.[homeState.toUpperCase()] || [];
    homeStateCities = [...knownCities, ...homeStateCities];
    this.strong = new RegExp(terms.us_strong.join('|'), 'i');
    this.stateCode = new RegExp(terms.us_state_code);        // case-sensitive: "IN" is a state, "in" is not
    this.city = words(terms.us_city);
    this.foreign = words(terms.foreign);
    this.foreignCode = new RegExp(terms.foreign_code);       // case-sensitive: country codes
    this.remoteRx = new RegExp(terms.remote, 'i');
    this.home = homeState
      ? new RegExp(
          [String.raw`\b${homeState}\b`, US_STATE_NAMES[homeState.toUpperCase()], ...homeStateCities]
            .filter(Boolean).join('|'),
          'i')
      : null;
  }

  /** Build from a loaded config (reads the terms file and the profile's home state). */
  static fromConfig(cfg) {
    const terms = JSON.parse(readFileSync(cfg.paths.geo_terms, 'utf8'));
    const loc = cfg.profile?.location || {};
    return new Geo(terms, { homeState: loc.home_state || '', homeStateCities: loc.home_state_cities || [] });
  }

  isRemote(text) {
    return this.remoteRx.test(text || '');
  }

  isHomeState(text) {
    return this.home ? this.home.test(text || '') : false;
  }

  /**
   * Classify one location string.
   * @returns {Domestic} 'yes' domestic, 'no' recognised foreign, 'check' unrecognised
   */
  domestic(loc) {
    const s = (loc || '').trim();
    if (!s) return 'check';
    if (this.strong.test(s)) return 'yes';
    if (this.foreign.test(s) || this.foreignCode.test(s)) return 'no';
    if (this.stateCode.test(s) || this.city.test(s)) return 'yes';
    return 'check';
  }

  /**
   * Rank a posting over one or more locations.
   * 1 remote domestic · 2 on-site outside the home state · 3 on-site in the home state ·
   * 4 outside the home country · 5 unverifiable (goes to a "check" sheet, never the shortlist).
   * @param {string[]} locs
   * @param {string} [all] combined text (locations plus e.g. a Workday remoteType hint)
   * @returns {{rank: number, domestic: Domestic}}
   */
  rank(locs, all = (locs || []).join('; ')) {
    const list = (locs || []).filter(Boolean);
    if (!list.length) return { rank: 5, domestic: 'check' };

    const states = list.map(l => this.domestic(l));
    const domesticLocs = list.filter((_, i) => states[i] === 'yes');

    if (states.every(s => s === 'no')) return { rank: 4, domestic: 'no' };
    if (this.isRemote(all)) {
      if (domesticLocs.length) return { rank: 1, domestic: 'yes' };
      // "Remote" with no domestic evidence and no foreign marker: needs a human.
      if (!states.includes('no')) return { rank: 5, domestic: 'check' };
    }
    if (domesticLocs.some(l => !this.isHomeState(l))) return { rank: 2, domestic: 'yes' };
    if (domesticLocs.length) return { rank: 3, domestic: 'yes' };
    return { rank: 5, domestic: 'check' };
  }
}

/**
 * Workday posting URLs carry the primary location: .../job/<Location-Slug>/<Title>_<Req>.
 * Used as a fallback when the listing only says "3 Locations".
 * @returns {string} human-readable location, or '' when the URL has none
 */
export function workdayUrlLocation(url) {
  const m = /myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?[^/]+\/job\/([^/]+)\//.exec(url || '');
  if (!m) return '';
  // Workday encodes a separator as "---" and an intra-word hyphen as "-", so split on the
  // separator first; a naive chained replace would also blank out the separator's own hyphen.
  return decodeURIComponent(m[1])
    .split('---')
    .map(part => part.replace(/-/g, ' ').trim())
    .join(' - ');
}
