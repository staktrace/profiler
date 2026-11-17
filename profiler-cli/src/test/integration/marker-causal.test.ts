/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Integration tests for `marker cause` and `marker critical-path`, against a
 * small profile with causal markers (see
 * src/test/fixtures/profiles/causal-markers.ts, which generates it): a
 * three-hop chain across two threads, a fan-in, and an unknown cause.
 */

import {
  createTestContext,
  cleanupTestContext,
  cli,
  cliFail,
  type CliTestContext,
} from './utils';

import type {
  MarkerCauseResult,
  MarkerCriticalPathResult,
  WithContext,
} from '../../protocol';

const FIXTURE = 'profiler-cli/src/test/fixtures/causal-chain.json';

describe('marker cause and critical-path', () => {
  let ctx: CliTestContext;
  const handles: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await createTestContext();
    await cli(ctx, ['load', FIXTURE]);
    // Listing the markers is what mints the m-N handles.
    const result = await cli(ctx, [
      'thread',
      'markers',
      '--thread',
      't-0',
      '--list',
      '--json',
    ]);
    for (const marker of JSON.parse(result.stdout).flatMarkers) {
      handles[marker.name] = marker.handle;
    }
  });

  afterAll(async () => {
    await cleanupTestContext(ctx);
  });

  async function json<T>(args: string[]): Promise<WithContext<T>> {
    const result = await cli(ctx, [...args, '--json']);
    return JSON.parse(result.stdout);
  }

  it('prints the critical path of the three-hop chain as text', async () => {
    const { stdout } = await cli(ctx, [
      'marker',
      'critical-path',
      handles['Handle result'],
    ]);
    expect(stdout).toContain('Critical path to marker');
    expect(stdout).toContain('Path length 90ms');
    expect(stdout).toContain('"Dispatch C" on t-1');
    expect(stdout).toMatch(/zoom push ts-\w+,ts-\w+/);
    expect(stdout).toContain('chain starts inside: m-');
    expect(stdout).toContain('"Paint"');
    expect(stdout).toContain('Stopped: the chain starts here');
  });

  it('returns structured critical-path JSON', async () => {
    const result = await json<MarkerCriticalPathResult>([
      'marker',
      'critical-path',
      handles['Handle result'],
    ]);
    expect(result.type).toBe('marker-critical-path');
    expect(result.stopReason).toBe('root');
    expect(result.maxDepth).toBe(100000);
    expect(result.segments.map((s) => s.kind)).toEqual([
      'root',
      'wait',
      'running',
      'wait',
      'running',
      'wait',
      'running',
    ]);
    expect(result.totalsByKind).toEqual({
      running: 30,
      waitBusy: 0,
      waitIdle: 60,
    });
    expect(result.totalMs).toBe(90);
    expect(result.segments[0].enclosingMarkers!.map((m) => m.name)).toEqual([
      'Paint',
      'Layout',
      'Style',
    ]);
  });

  it('honors --max-depth', async () => {
    const result = await json<MarkerCriticalPathResult>([
      'marker',
      'critical-path',
      handles['Handle result'],
      '--max-depth',
      '2',
    ]);
    expect(result.maxDepth).toBe(2);
    expect(result.stopReason).toBe('max-depth');
    expect(result.segments.filter((s) => s.kind === 'wait')).toHaveLength(2);
  });

  it('reports a fan-in and an unknown cause', async () => {
    const tick = await json<MarkerCriticalPathResult>([
      'marker',
      'critical-path',
      handles['Refresh tick'],
    ]);
    expect(
      tick.segments.find((s) => s.kind === 'wait')!.alternateCauseCount
    ).toBe(1);

    const orphan = await json<MarkerCriticalPathResult>([
      'marker',
      'critical-path',
      handles['Orphan task'],
    ]);
    expect(orphan.stopReason).toBe('unknown-cause');
  });

  it('prints the causal links of a marker', async () => {
    const { stdout } = await cli(ctx, [
      'marker',
      'cause',
      handles['Refresh tick'],
    ]);
    expect(stdout).toContain('Causal links for marker');
    expect(stdout).toContain('Caused by: m-');
    expect(stdout).toContain('Also caused by (alternate): m-');

    const result = await json<MarkerCauseResult>([
      'marker',
      'cause',
      handles['Orphan task'],
    ]);
    expect(result.occurrences[0].causes).toEqual({ kind: 'unknown' });
  });

  it('accepts a range of segments with zoom push', async () => {
    const result = await json<MarkerCriticalPathResult>([
      'marker',
      'critical-path',
      handles['Handle result'],
    ]);
    const wait = result.segments.find((s) => s.kind === 'wait')!;
    const { stdout } = await cli(ctx, [
      'zoom',
      'push',
      `${wait.startName},${wait.endName}`,
    ]);
    expect(stdout).toContain('Pushed view range');
    await cli(ctx, ['zoom', 'clear']);
  });

  it('rejects ranges, bad depths and unknown handles', async () => {
    const range = await cliFail(ctx, ['marker', 'cause', 'm-1..m-2']);
    expect(range.exitCode).toBe(1);
    expect(range.stderr).toContain('takes a single handle');

    const depth = await cliFail(ctx, [
      'marker',
      'critical-path',
      handles['Handle result'],
      '--max-depth',
      '0',
    ]);
    expect(depth.stderr).toContain('--max-depth must be a positive integer');

    const unknown = await cliFail(ctx, ['marker', 'cause', 'm-999']);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toContain('Unknown marker m-999');
  });
});
