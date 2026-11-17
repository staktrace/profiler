/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ProfileQuerier } from 'firefox-profiler/profile-query';
import { getProfileRootRange } from 'firefox-profiler/selectors/profile';
import { storeWithProfile } from '../../fixtures/stores';
import { getProfileWithCausalMarkers } from '../../fixtures/profiles/causal-markers';
import { getProfileWithMarkers } from '../../fixtures/profiles/processed-profile';
import type { Profile } from 'firefox-profiler/types';

function makeQuerier(profile: Profile) {
  const store = storeWithProfile(profile);
  return new ProfileQuerier(store, getProfileRootRange(store.getState()));
}

async function handleFor(
  querier: ProfileQuerier,
  thread: string,
  name: string,
  nth: number = 0
): Promise<string> {
  const result = await querier.threadMarkers(thread, { list: true });
  const matches = result.flatMarkers!.filter((m) => m.name === name);
  return matches[nth].handle;
}

describe('ProfileQuerier causal markers', function () {
  describe('markerCause', function () {
    it('reports the cause of an effect and the effects of a trigger', async function () {
      const querier = makeQuerier(getProfileWithCausalMarkers());
      const handleResult = await handleFor(querier, 't-0', 'Handle result');
      const effect = await querier.markerCause(handleResult);

      expect(effect.type).toBe('marker-cause');
      expect(effect.hasCausalSchema).toBe(true);
      expect(effect.enclosing).toBeNull();
      expect(effect.occurrences).toHaveLength(1);
      const [occurrence] = effect.occurrences;
      expect(occurrence).toMatchObject({
        role: 'effect',
        id: '00000000000000c3',
        causes: {
          kind: 'known',
          primary: {
            role: 'trigger',
            marker: {
              name: 'Dispatch C',
              threadHandle: 't-1',
              start: 80,
              end: null,
            },
          },
          alternates: [],
        },
      });

      const triggerHandle = (occurrence.causes as any).primary.marker
        .markerHandle;
      const trigger = await querier.markerCause(triggerHandle);
      expect(trigger.occurrences[0]).toMatchObject({
        role: 'trigger',
        effects: [{ isPrimary: true, marker: { markerHandle: handleResult } }],
      });
      // The trigger was emitted by the interval it is nested in.
      expect(trigger.enclosing).toMatchObject({
        role: 'effect',
        marker: { name: 'Run B', start: 70, end: 90 },
      });
    });

    it('lists the alternate causes of a fan-in', async function () {
      const querier = makeQuerier(getProfileWithCausalMarkers());
      const tick = await querier.markerCause(
        await handleFor(querier, 't-0', 'Refresh tick')
      );
      const causes = tick.occurrences[0].causes as any;
      expect(causes.kind).toBe('known');
      expect(causes.primary.marker).toMatchObject({
        threadHandle: 't-1',
        start: 120,
      });
      expect(causes.alternates).toHaveLength(1);
      expect(causes.alternates[0].marker).toMatchObject({
        threadHandle: 't-2',
        start: 125,
      });
    });

    it('reports an unknown cause', async function () {
      const querier = makeQuerier(getProfileWithCausalMarkers());
      const orphan = await querier.markerCause(
        await handleFor(querier, 't-0', 'Orphan task')
      );
      expect(orphan.occurrences[0].causes).toEqual({ kind: 'unknown' });
    });

    it('reports a marker without causal fields', async function () {
      const querier = makeQuerier(getProfileWithCausalMarkers());
      const startup = await querier.markerCause(
        await handleFor(querier, 't-0', 'Startup')
      );
      expect(startup.occurrences).toEqual([]);
      expect(startup.enclosing).toBeNull();
    });

    it('rejects an unknown handle', async function () {
      const querier = makeQuerier(getProfileWithCausalMarkers());
      await expect(querier.markerCause('m-999')).rejects.toThrow(
        'Unknown marker m-999'
      );
    });
  });

  describe('markerCriticalPath', function () {
    it('lists only the last segments when asked, and can follow causes only', async function () {
      const querier = makeQuerier(getProfileWithCausalMarkers());
      const handle = await handleFor(querier, 't-0', 'Handle result');
      const all = await querier.markerCriticalPath(handle);
      const last = await querier.markerCriticalPath(handle, {
        maxSegments: 2,
      });

      expect(last.segmentCount).toBe(all.segments.length);
      expect(last.omittedSegments).toBe(all.segments.length - 2);
      expect(last.segments).toEqual(all.segments.slice(-2));
      // The totals and the top contributors cover the whole path.
      expect(last.totalMs).toBe(all.totalMs);
      expect(last.topRunning).toEqual(all.topRunning);

      const causal = await querier.markerCriticalPath(handle, {
        follow: 'causal',
      });
      expect(causal.follow).toBe('causal');
    });

    it('walks the three-hop chain', async function () {
      const querier = makeQuerier(getProfileWithCausalMarkers());
      const handle = await handleFor(querier, 't-0', 'Handle result');
      const result = await querier.markerCriticalPath(handle);

      expect(result.type).toBe('marker-critical-path');
      expect(result.markerHandle).toBe(handle);
      expect(result.maxDepth).toBe(100000);
      expect(result.follow).toBe('blocking');
      expect(result.segmentCount).toBe(result.segments.length);
      expect(result.omittedSegments).toBe(0);
      expect(result.topRunning.map((t) => t.label).sort()).toEqual([
        'Handle result',
        'Run A',
        'Run B',
      ]);
      expect(result.stopReason).toBe('root');
      expect(result.hasCausalSchema).toBe(true);
      expect(result.warnings).toEqual([]);
      expect(
        result.segments.map((s) => [s.kind, s.threadHandle, s.start, s.end])
      ).toEqual([
        ['root', 't-1', 20, 20],
        ['wait', 't-0', 20, 40],
        ['running', 't-0', 40, 50],
        ['wait', 't-1', 50, 70],
        ['running', 't-1', 70, 80],
        ['wait', 't-0', 80, 100],
        ['running', 't-0', 100, 110],
      ]);

      const last = result.segments[result.segments.length - 1];
      expect(last.entryMarker).toMatchObject({
        markerHandle: handle,
        name: 'Handle result',
      });
      expect(last.duration).toBe(10);
      expect(last.startName).toMatch(/^ts-/);
      expect(last.endName).toMatch(/^ts[-<>]/);

      const wait = result.segments[5];
      expect(wait).toMatchObject({
        sourceThreadHandle: 't-1',
        sourceThreadName: 'DOM Worker',
        triggerMarker: { name: 'Dispatch C' },
        effectMarker: { markerHandle: handle },
        alternateCauseCount: 0,
        busyMs: 0,
        idleMs: 20,
      });

      expect(result.totalMs).toBe(90);
      expect(result.totalsByKind).toEqual({
        running: 30,
        waitBusy: 0,
        waitIdle: 60,
      });
      expect(
        result.totalsByThread.map((t) => [t.threadHandle, t.total])
      ).toEqual([
        ['t-0', 60],
        ['t-1', 30],
      ]);
    });

    it('gives the root the innermost enclosing markers of any type', async function () {
      const querier = makeQuerier(getProfileWithCausalMarkers());
      const result = await querier.markerCriticalPath(
        await handleFor(querier, 't-0', 'Handle result')
      );
      const root = result.segments[0];
      expect(root.kind).toBe('root');
      expect(root.duration).toBe(0);
      // Four markers contain t-1 @20; the three innermost are listed, latest
      // start first. "After" [21,30] does not contain it.
      expect(root.enclosingMarkers).toMatchObject([
        { name: 'Paint', threadHandle: 't-1', start: 15, end: 25 },
        { name: 'Layout', start: 10, end: 30 },
        { name: 'Style', start: 5, end: 35 },
      ]);
      // The handles resolve to the markers they name.
      const handles = root.enclosingMarkers!.map((m) => m.markerHandle);
      expect(new Set(handles).size).toBe(3);
      const paint = await querier.markerCause(handles[0]);
      expect(paint.markerName).toBe('Paint');
    });

    it('gives the root no enclosing markers when none contain it', async function () {
      const querier = makeQuerier(getProfileWithCausalMarkers());
      const result = await querier.markerCriticalPath(
        await handleFor(querier, 't-0', 'Refresh tick')
      );
      const root = result.segments[0];
      expect(root).toMatchObject({ kind: 'root', threadHandle: 't-1' });
      expect(root.start).toBe(120);
      expect(root.enclosingMarkers).toEqual([]);
    });

    it('counts alternate causes on a fan-in', async function () {
      const querier = makeQuerier(getProfileWithCausalMarkers());
      const result = await querier.markerCriticalPath(
        await handleFor(querier, 't-0', 'Refresh tick')
      );
      const wait = result.segments.find((s) => s.kind === 'wait')!;
      expect(wait.alternateCauseCount).toBe(1);
      expect(wait.sourceThreadHandle).toBe('t-1');
    });

    it('stops on an unknown cause', async function () {
      const querier = makeQuerier(getProfileWithCausalMarkers());
      const result = await querier.markerCriticalPath(
        await handleFor(querier, 't-0', 'Orphan task')
      );
      expect(result.stopReason).toBe('unknown-cause');
      expect(result.segments.map((s) => s.kind)).toEqual([
        'unknown-cause',
        'running',
      ]);
    });

    it('honors maxDepth and validates it', async function () {
      const querier = makeQuerier(getProfileWithCausalMarkers());
      const handle = await handleFor(querier, 't-0', 'Handle result');
      const result = await querier.markerCriticalPath(handle, { maxDepth: 1 });
      expect(result.stopReason).toBe('max-depth');
      expect(result.segments.map((s) => s.kind)).toEqual(['wait', 'running']);
      await expect(
        querier.markerCriticalPath(handle, { maxDepth: 0 })
      ).rejects.toThrow('max depth');
    });

    it('warns when the profile has no causal schema', async function () {
      const profile = getProfileWithMarkers([
        ['Alpha', 10, null, { type: 'tracing', category: 'Test' }],
      ]);
      const querier = makeQuerier(profile);
      const result = await querier.markerCriticalPath(
        await handleFor(querier, 't-0', 'Alpha')
      );
      expect(result.hasCausalSchema).toBe(false);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('without causal markers');
      expect(result.stopReason).toBe('root');
      expect(result.segments.map((s) => s.kind)).toEqual(['root']);
      expect(result.segments[0].enclosingMarkers).toEqual([]);
      expect(result.totalMs).toBe(0);
    });

    it('computes the causal graph once', async function () {
      const querier = makeQuerier(getProfileWithCausalMarkers());
      const handle = await handleFor(querier, 't-0', 'Handle result');
      await querier.markerCause(handle);
      const data = querier._causalData;
      expect(data).not.toBeNull();
      await querier.markerCriticalPath(handle);
      expect(querier._causalData).toBe(data);
    });
  });
});
