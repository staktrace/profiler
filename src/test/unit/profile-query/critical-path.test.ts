/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  computeCausalGraph,
  getBusyTime,
} from 'firefox-profiler/profile-logic/causal-links';
import { walkCriticalPath } from 'firefox-profiler/profile-query/critical-path';
import { StringTable } from 'firefox-profiler/utils/string-table';
import type { Marker } from 'firefox-profiler/types';
import type { MarkerSchema } from 'firefox-profiler/types/markers';

const schemas: MarkerSchema[] = [
  {
    name: 'Trigger',
    display: [],
    fields: [{ key: 'trigger', format: 'causal-trigger-id' }],
  },
  {
    name: 'Effect',
    display: [],
    isStackBased: true,
    fields: [{ key: 'effect', format: 'causal-effect-id' }],
  },
  {
    // Effect of one id and trigger of another (the trigger is read at the
    // marker's start).
    name: 'Relay',
    display: [],
    isStackBased: true,
    fields: [
      { key: 'cause', format: 'causal-effect-id' },
      { key: 'next', format: 'causal-trigger-id' },
    ],
  },
];

class Builder {
  stringArray: string[] = [];
  stringTable = StringTable.withBackingArray(this.stringArray);
  threads: Marker[][] = [[], [], []];

  private add(thread: number, start: number, end: number | null, data: any) {
    this.threads[thread].push({
      start,
      end,
      name: data.type,
      category: 0,
      threadId: thread,
      data,
    });
    return this.threads[thread].length - 1;
  }

  trigger(thread: number, id: string, time: number) {
    return this.add(thread, time, null, {
      type: 'Trigger',
      trigger: this.stringTable.indexForString(id),
    });
  }

  effect(thread: number, id: string, start: number, end: number) {
    return this.add(thread, start, end, {
      type: 'Effect',
      effect: this.stringTable.indexForString(id),
    });
  }

  relay(
    thread: number,
    causeId: string,
    nextId: string,
    start: number,
    end: number
  ) {
    return this.add(thread, start, end, {
      type: 'Relay',
      cause: this.stringTable.indexForString(causeId),
      next: this.stringTable.indexForString(nextId),
    });
  }

  graph() {
    return computeCausalGraph(this.threads, schemas, this.stringTable);
  }
}

const opts = { maxDepth: 50, profileStart: 0 };

describe('walkCriticalPath', () => {
  function threeHopChain() {
    const b = new Builder();
    // Thread 1 emits id A at 20, outside of any causal interval (the root).
    b.trigger(1, 'A', 20);
    // Thread 0 runs A in [40, 60] and, inside it, triggers B at 50.
    const effectA = b.effect(0, 'A', 40, 60);
    b.trigger(0, 'B', 50);
    // Thread 1 runs B in [70, 90] and, inside it, triggers C at 80.
    const effectB = b.effect(1, 'B', 70, 90);
    b.trigger(1, 'C', 80);
    // Thread 0 runs C in [100, 110]: this is the marker being analyzed.
    const effectC = b.effect(0, 'C', 100, 110);
    return { graph: b.graph(), effectA, effectB, effectC };
  }

  it('walks a three-hop chain across two threads', () => {
    const { graph, effectA, effectB, effectC } = threeHopChain();
    const walk = walkCriticalPath(graph, 0, 110, opts);

    expect(
      walk.segments.map((s) => [s.kind, s.threadIndex, s.start, s.end])
    ).toEqual([
      ['root', 1, 20, 20],
      ['wait', 0, 20, 40],
      ['running', 0, 40, 50],
      ['wait', 1, 50, 70],
      ['running', 1, 70, 80],
      ['wait', 0, 80, 100],
      ['running', 0, 100, 110],
    ]);
    expect(walk.stopReason).toBe('root');

    const [, waitA, runA, waitB, runB, waitC, runC] = walk.segments;
    expect(runC.entryMarker).toEqual({ threadIndex: 0, markerIndex: effectC });
    expect(runB.entryMarker).toEqual({ threadIndex: 1, markerIndex: effectB });
    expect(runA.entryMarker).toEqual({ threadIndex: 0, markerIndex: effectA });

    expect(waitC).toMatchObject({
      sourceThreadIndex: 1,
      threadIndex: 0,
      effectMarker: { threadIndex: 0, markerIndex: effectC },
      triggerMarker: { threadIndex: 1, markerIndex: expect.any(Number) },
      alternateCauseCount: 0,
    });
    expect(waitB.sourceThreadIndex).toBe(0);
    expect(waitA.sourceThreadIndex).toBe(1);

    // The root adds nothing: 10 + 10 + 10 running, 20 + 20 + 20 idle waiting.
    expect(walk.totalsByKind).toEqual({
      running: 30,
      waitBusy: 0,
      waitIdle: 60,
    });
    expect(walk.totalsByThread.map((t) => [t.threadIndex, t.total])).toEqual([
      [0, 60],
      [1, 30],
    ]);
  });

  it('reports the primary cause and counts the alternates on a fan-in', () => {
    const b = new Builder();
    b.trigger(1, 'F', 10);
    b.trigger(2, 'F', 15);
    b.effect(0, 'F', 30, 40);
    const walk = walkCriticalPath(b.graph(), 0, 40, opts);

    const wait = walk.segments.find((s) => s.kind === 'wait')!;
    expect(wait).toMatchObject({
      sourceThreadIndex: 1,
      start: 10,
      end: 30,
      alternateCauseCount: 1,
    });
    // The walk continues from the primary only.
    expect(walk.segments[0]).toMatchObject({
      kind: 'root',
      threadIndex: 1,
      start: 10,
      end: 10,
    });
    expect(walk.segments.some((s) => s.threadIndex === 2)).toBe(false);
  });

  it('stops at an effect whose cause is unknown', () => {
    const b = new Builder();
    const effect = b.effect(0, 'U', 30, 40);
    const walk = walkCriticalPath(b.graph(), 0, 40, opts);

    expect(walk.stopReason).toBe('unknown-cause');
    expect(walk.segments.map((s) => s.kind)).toEqual([
      'unknown-cause',
      'running',
    ]);
    expect(walk.segments[0]).toMatchObject({
      start: 30,
      end: 30,
      entryMarker: { threadIndex: 0, markerIndex: effect },
    });
    expect(walk.totalsByKind.running).toBe(10);
  });

  it('ends in a zero-length root outside of any causal interval', () => {
    const b = new Builder();
    b.effect(0, 'X', 30, 40);
    const walk = walkCriticalPath(b.graph(), 0, 50, opts);
    expect(walk.stopReason).toBe('root');
    expect(walk.segments).toEqual([
      { kind: 'root', threadIndex: 0, start: 50, end: 50 },
    ]);
    // Nothing is known about the time before the root, so nothing is counted.
    expect(walk.totalsByKind).toEqual({ running: 0, waitBusy: 0, waitIdle: 0 });
    expect(walk.totalsByThread.map((t) => t.total)).toEqual([0]);
    // The same with a profile start long before the root.
    const far = walkCriticalPath(b.graph(), 0, 50, {
      maxDepth: 50,
      profileStart: -1000,
    });
    expect(far.segments).toEqual(walk.segments);
  });

  it('terminates on a marker that is the trigger and effect of one id', () => {
    const b = new Builder();
    // Its own trigger sorts before it at the same time: a self-link.
    const self = b.relay(0, 'S', 'S', 10, 20);
    const walk = walkCriticalPath(b.graph(), 0, 20, opts);

    expect(walk.stopReason).toBe('revisited-marker');
    expect(walk.segments.length).toBeLessThanOrEqual(3);
    expect(
      walk.segments.filter((s) => s.entryMarker?.markerIndex === self)
    ).toHaveLength(2); // one running, and the wait that ends in it
  });

  it('stops when the next time does not strictly decrease', () => {
    const b = new Builder();
    b.trigger(0, 'N', 10);
    b.effect(1, 'N', 10, 10);
    const walk = walkCriticalPath(b.graph(), 1, 10, opts);
    expect(walk.stopReason).toBe('non-decreasing-time');
    expect(walk.segments.map((s) => s.kind)).toEqual(['wait', 'running']);
  });

  it('stops when it reaches the start of the profile', () => {
    const b = new Builder();
    b.trigger(1, 'P', 0);
    b.effect(0, 'P', 10, 20);
    const walk = walkCriticalPath(b.graph(), 0, 20, opts);
    expect(walk.stopReason).toBe('profile-start');
    expect(walk.segments.map((s) => [s.kind, s.start, s.end])).toEqual([
      ['wait', 0, 10],
      ['running', 10, 20],
    ]);
  });

  it('stops at the maximum depth', () => {
    const { graph } = threeHopChain();
    const one = walkCriticalPath(graph, 0, 110, { ...opts, maxDepth: 1 });
    expect(one.stopReason).toBe('max-depth');
    expect(one.segments.map((s) => [s.kind, s.start, s.end])).toEqual([
      ['wait', 80, 100],
      ['running', 100, 110],
    ]);

    const three = walkCriticalPath(graph, 0, 110, { ...opts, maxDepth: 3 });
    expect(three.stopReason).toBe('max-depth');
    expect(three.segments.filter((s) => s.kind === 'wait')).toHaveLength(3);
    expect(three.segments[0].kind).toBe('wait');

    // Exactly enough depth reaches the root.
    const four = walkCriticalPath(graph, 0, 110, { ...opts, maxDepth: 4 });
    expect(four.stopReason).toBe('root');
  });

  it('splits a wait into time queued behind other work and idle time', () => {
    const b = new Builder();
    b.trigger(1, 'W', 100);
    // Thread 0 runs other top-level work during the wait: [110, 130], and
    // [150, 190] which is still running when W starts. A nested interval is not
    // counted twice.
    b.effect(0, 'Q1', 110, 130);
    b.effect(0, 'Q1', 115, 120);
    b.effect(0, 'Q2', 150, 190);
    // The effect the wait ends in is W, at [170, 180].
    b.effect(0, 'W', 170, 180);
    const walk = walkCriticalPath(b.graph(), 0, 180, opts);

    const wait = walk.segments.find((s) => s.kind === 'wait')!;
    expect(wait.start).toBe(100);
    expect(wait.end).toBe(170);
    // Only [110, 130] counts. Q2 contains the end of the wait (170), so the
    // thread was already running in it rather than queued behind it.
    expect(wait.busyMs).toBe(20);
    expect(wait.idleMs).toBe(50);
    expect(walk.totalsByKind.waitBusy).toBe(20);
    expect(walk.totalsByKind.waitIdle).toBe(50);
  });
});

describe('getBusyTime', () => {
  it('sums the overlap with top-level intervals only', () => {
    const b = new Builder();
    b.effect(0, 'a', 10, 20);
    b.effect(0, 'b', 12, 18); // nested
    b.effect(0, 'c', 30, Infinity); // incomplete
    const graph = b.graph();
    expect(getBusyTime(graph, 0, 0, 100)).toBe(10 + 70);
    expect(getBusyTime(graph, 0, 15, 35)).toBe(5 + 5);
    expect(getBusyTime(graph, 0, 20, 30)).toBe(0);
    expect(getBusyTime(graph, 0, 0, 100, 15)).toBe(70);
    expect(getBusyTime(graph, 5, 0, 100)).toBe(0);
    expect(getBusyTime(graph, 0, 50, 50)).toBe(0);
  });
});
