import { describe, expect, it } from 'vitest';
import type { Ctx } from '../src/context.js';
import { niceCeil, shareBar, stackedColumns } from '../src/pages/chart.js';

const ctx = { lang: 'en' } as Ctx;

function chart(columns: Array<Record<string, number>>) {
  return stackedColumns(ctx, {
    id: 'activity',
    title: 'Activity <last 30 days>',
    summary: '12 events',
    series: [
      { key: 'claude-code', label: 'claude-code', slot: 1 },
      { key: 'codex', label: 'codex', slot: 3 },
    ],
    columns: columns.map((values, i) => ({ label: `D${i}`, name: `Day ${i}`, values })),
    labelEvery: 2,
    columnHeading: 'Day',
    totalHeading: 'Total',
    tableLabel: 'Show the numbers',
  }).value;
}

describe('the stacked column chart', () => {
  it('is an accessible SVG, coloured by class, with every number in a table', () => {
    const out = chart([{ 'claude-code': 4, codex: 2 }, {}, { codex: 6 }]);
    expect(out).toContain(
      '<svg class="admin-chart-svg" viewBox="0 0 720 200" role="img" aria-labelledby="activity-title activity-desc" focusable="false">',
    );
    expect(out).toContain('<title id="activity-title">Activity &lt;last 30 days&gt;</title>');
    expect(out).toContain('<desc id="activity-desc">12 events</desc>');
    // The series keep their slots; the lower segment is a rectangle, the top one rounded.
    expect(out.match(/class="admin-chart-bar admin-series-1"/g)).toHaveLength(1);
    expect(out.match(/class="admin-chart-bar admin-series-3"/g)).toHaveLength(2);
    expect(out).toMatch(/<rect class="admin-chart-bar admin-series-1" x="[\d.]+" y="[\d.]+"/);
    expect(out).toMatch(/<path class="admin-chart-bar admin-series-3" d="M[\d. MVQHZ]+"\/>/);
    // Each column tells its numbers on hover; empty columns have none to tell.
    expect(out).toContain('<title>Day 0: 6\nclaude-code 4\ncodex 2</title>');
    expect(out).toContain('<title>Day 1: 0</title>');
    // Labels under every second column, counted from the last.
    expect(out.match(/class="admin-chart-label"/g)).toHaveLength(2);
    expect(out).toContain('text-anchor="end">D2</text>');
    // The legend and the table.
    expect(out).toContain(
      '<span class="admin-swatch admin-series-3" aria-hidden="true"></span><span>codex</span><span class="admin-legend-value">8</span>',
    );
    expect(out).toContain(
      '<tr><td class="ol-nowrap">Day 2</td><td class="ol-num">0</td><td class="ol-num">6</td><td class="ol-num">6</td></tr>',
    );
    expect(out).not.toMatch(/\sstyle=|\sfill="#|\son[a-z]+=/);
  });

  it('scales to a round maximum whose half is round too', () => {
    expect([0, 1, 7, 10, 11, 21, 6474, 8001, 45_000].map(niceCeil)).toEqual([
      1, 1, 8, 10, 20, 30, 8000, 10_000, 50_000,
    ]);
    expect(chart([{ codex: 6474 }])).toContain('>8K</text>');
  });

  it('draws share bars with attributes only', () => {
    expect(shareBar(5, 10, '5 events').value).toBe(
      '<svg class="admin-share" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label="5 events"><rect class="admin-share-track" width="100" height="6" rx="3"/><rect class="admin-share-bar admin-series-1" width="50" height="6" rx="3"/></svg>',
    );
    expect(shareBar(0, 0, 'none').value).toContain('width="0"');
  });
});
