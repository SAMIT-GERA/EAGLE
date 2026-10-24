import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');

describe('Stage 3 execution layout', () => {
  it('keeps live controls and the real execution state in deliberate separate columns', () => {
    const controls = source.indexOf('className="execution-controls"');
    const report = source.indexOf('className="execution-report"');

    expect(controls).toBeGreaterThan(-1);
    expect(report).toBeGreaterThan(controls);
    expect(source).toContain('id="execution-report-title"');
    expect(source).toContain('onClick={p.start}');
    expect(source).toContain('onClick={p.refresh}');
    expect(source).toContain('p.run.comparison.status');
    expect(source).toContain('p.run.traces.map');
  });
});
