import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { SCORE_BANDS, scoreBand } from '../src/standing';

// The status page counts every agent in bands (site/assets/score-report.js), and sigvara_check_agent
// names the band an agent is in. If the two differed, an agent could be told it sits in a band the page
// does not have.
const site = createRequire(__filename)(join(__dirname, '..', '..', '..', 'site', 'assets', 'score-report.js'));

describe('score bands', () => {
  it('are the bands the status page counts in', () => {
    expect(SCORE_BANDS).toEqual(site.BANDS);
  });

  it('name the band of every score from 0 to 100, and nothing else', () => {
    expect([0, 29, 30, 49, 50, 59, 60, 79, 80, 100].map(scoreBand))
      .toEqual(['0-29', '0-29', '30-39', '40-49', '50-59', '50-59', '60-79', '60-79', '80-100', '80-100']);
    for (const s of [-1, 101, 40.5, NaN]) expect(scoreBand(s)).toBeNull();
    for (let s = 0; s <= 100; s++) expect(scoreBand(s)).toBe(`${SCORE_BANDS[site.bandOf(s)].join('-')}`);
  });
});
