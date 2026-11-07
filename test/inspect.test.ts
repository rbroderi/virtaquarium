import { describe, expect, it } from 'vitest';
import { fmtMetres, fmtSeconds, fmtSpeed, inspectHtml, modeLabel } from '../src/inspect.js';
import { Jelly } from '../src/jelly/jelly.js';
import type { JellyBounds, JellySpecies } from '../src/jelly/types.js';

describe('inspect panel', () => {
  it('renders headings, values, bars and facts in the brain panel style', () => {
    const html = inspectHtml({
      title: 'Day Octopus', sci: 'Octopus cyanea', note: 'Foraging',
      rows: [{ heading: 'State' }, { label: 'Mode', value: 'Forage' }, { label: 'Jet', bar: 0.5, cls: 'energy' }],
      fact: 'A fact.',
    });
    expect(html).toContain('<h2>Day Octopus</h2>');
    expect(html).toContain('<em>Octopus cyanea</em>');
    expect(html).toContain('<h3>State</h3>');
    expect(html).toContain('<span class="val">Forage</span>');
    expect(html).toContain('class="bar energy"');
    expect(html).toContain('width:50%');
    expect(html).toContain('<p class="fact">A fact.</p>');
  });

  it('escapes text and clamps bars', () => {
    const html = inspectHtml({ title: '<worm> & "co"', rows: [{ label: 'x', bar: 3 }] });
    expect(html).toContain('&lt;worm&gt; &amp; &quot;co&quot;');
    expect(html).toContain('width:100%');
  });

  it('formats speeds, times, heights and distances for people', () => {
    expect(fmtSpeed(0.8)).toBe('10 cm/s');
    expect(fmtSpeed(-0.4)).toBe('5.0 cm/s');
    expect(fmtSeconds(4.2)).toBe('5 s');
    expect(fmtSeconds(-2)).toBe('0 s');
    expect(fmtSeconds(Infinity)).toBe('—');
    expect(fmtMetres(8)).toBe('1.00 m');
    expect(modeLabel('hover')).toBe('Hover');
  });

  it('builds a panel from a jelly\'s own live state', () => {
    const sp: JellySpecies = {
      id: 'moonjelly', name: 'Moon Jelly', sci: 'Aurelia aurita', habitat: 'jelly', count: 1,
      fact: 'Mostly water.', size: [0.6, 1.2],
    };
    const bounds: JellyBounds = { x0: -8, x1: 8, y0: 0, y1: 9, z0: -3, z1: 2.7 };
    const jelly = new Jelly(sp, () => 0.5, bounds);
    const panel = jelly.inspect();
    expect(jelly.pickRadius).toBeGreaterThan(0);
    expect(panel.title).toBe('Moon Jelly');
    expect(panel.rows.some((r) => r.label === 'Pulse rate')).toBe(true);
    expect(panel.rows.some((r) => r.label === 'Bell' && r.bar !== undefined)).toBe(true);
  });
});
