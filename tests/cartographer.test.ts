import { describe, expect, it } from 'vitest';
import { analyzeCodebase } from '../src/cartographer/index.js';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('AST cartographer', () => {
  const report = analyzeCodebase('./fixtures/vibe-mart');
  it('inventories source files and flags large components', () => {
    expect(report.files).toHaveLength(6);
    for (const name of ['ShopDashboard', 'CheckoutModal', 'OrderManagement']) {
      expect(report.files.find(f => f.path.endsWith(`${name}.tsx`))).toMatchObject({ monolithScore: true });
    }
    expect(report.files.find(f => f.path.endsWith('types.ts'))?.monolithScore).toBe(false);
  });
  it('groups normalized pricing and coupon expressions across all three components', () => {
    for (const fragment of ['VIBE20', 'toFixed']) {
      expect(report.duplicatedLogic.some(group => group.signature.includes(fragment) &&
        new Set(group.occurrences.map(o => o.file)).size === 3)).toBe(true);
    }
    expect(report.duplicatedLogic.every(g => g.occurrences.every(o => o.line > 0))).toBe(true);
  });
  it('finds write-only hooks and mutation-only locals without flagging real inputs', () => {
    const names = report.orphanedState.map(s => s.name);
    expect(names).toEqual(expect.arrayContaining(['hoveredProductIndex', 'tempZipCodeBuffer',
      'sessionTimeoutId', 'lastPollingTime', 'totalCatalogImpressions', 'inMemoryAuditQueue']));
    expect(names).not.toContain('promoInputDraft');
    expect(names).not.toContain('cart');
    expect(names).not.toContain('zipCode');
  });
  it('compares mock API routes with component endpoints', () => {
    const orders = report.apiInconsistencies.find(a => a.resource === 'orders');
    expect(orders?.endpoints).toEqual(expect.arrayContaining(['/api/v1/orders', '/api/orders']));
    expect(orders?.occurrences.some(o => o.file.endsWith('mockApi.ts'))).toBe(true);
    expect(orders?.occurrences.some(o => o.file.endsWith('OrderManagement.tsx'))).toBe(true);
  });
  it('reports empty and comment-only catch blocks at their source locations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibedebt-catches-'));
    try {
      writeFileSync(join(dir, 'retries.ts'), [
        'try { retry(); } catch {}',
        'try { retry(); } catch (error) {',
        '  // This handler has no statements.',
        '}',
        'try { retry(); } catch { /* Intentionally empty. */ }',
        'try { retry(); } catch (error) { throw error; }',
        'try { retry(); } finally { cleanup(); }',
      ].join('\n'));
      expect(analyzeCodebase(dir).emptyCatchBlocks).toEqual([
        expect.objectContaining({ file: 'retries.ts', line: 1, snippet: 'catch {}' }),
        expect.objectContaining({ file: 'retries.ts', line: 2, snippet: expect.stringContaining('catch (error)') }),
        expect.objectContaining({ file: 'retries.ts', line: 5, snippet: 'catch { /* Intentionally empty. */ }' }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('rejects missing targets', () => {
    expect(() => analyzeCodebase('./does-not-exist')).toThrow(/directory/i);
  });
  it('inventories state hooks and detects shared tax and shipping rules', () => {
    expect(report.files.find(f => f.path.endsWith('CheckoutModal.tsx'))?.stateHooks)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'zipCode', setter: 'setZipCode' })]));
    expect(report.duplicatedLogic.map(c => c.category)).toEqual(expect.arrayContaining(['tax', 'shipping', 'coupon']));
    expect(report.orphanedState.map(s => s.name).sort()).toEqual([
      'hoveredProductIndex', 'inMemoryAuditQueue', 'lastPollingTime',
      'sessionTimeoutId', 'tempZipCodeBuffer', 'totalCatalogImpressions',
    ]);
  });
  it('runs the package launcher and writes the same JSON report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibedebt-cli-'));
    try {
      const output = join(dir, 'report.json');
      const result = spawnSync(process.execPath,
        ['bin/vibedebt.js', 'map', './fixtures/vibe-mart', '--out', output], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Monolithic files: 3');
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(report);
      const missing = spawnSync(process.execPath,
        ['bin/vibedebt.js', 'map', join(dir, 'missing')], { encoding: 'utf8' });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('existing directory');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('distinguishes self-updated locals from values returned to callers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vibedebt-'));
    try {
      writeFileSync(join(dir, 'counter.ts'), `
        export function run() {
          let unused = 0;
          unused = unused + 1;
          let used = 0;
          used = used + 1;
          let escaped = 0;
          const output = { value: 0 };
          escaped = (output.value = escaped + 1);
          return { used, output };
        }
      `);
      const names = analyzeCodebase(dir).orphanedState.map(s => s.name);
      expect(names).toContain('unused');
      expect(names).not.toContain('used');
      expect(names).not.toContain('escaped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
