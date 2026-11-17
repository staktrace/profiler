/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  computeCausalGraph,
  findCausalEntry,
  getCauses,
  getMarkerOccurrences,
} from 'firefox-profiler/profile-logic/causal-links';
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
    name: 'SharedEffect',
    display: [],
    isStackBased: true,
    fields: [{ key: 'effect', format: 'causal-shared-effect-id' }],
  },
  {
    // A marker that is an effect of one id and a trigger for another.
    name: 'Relay',
    display: [],
    isStackBased: true,
    fields: [
      { key: 'cause', format: 'causal-effect-id' },
      { key: 'next', format: 'causal-trigger-id' },
    ],
  },
  {
    name: 'Plain',
    display: [],
    fields: [{ key: 'flow', format: 'flow-id' }],
  },
];

type Kind = 'Trigger' | 'Effect' | 'SharedEffect';

class Builder {
  stringArray: string[] = [];
  stringTable = StringTable.withBackingArray(this.stringArray);
  threads: Marker[][] = [];

  thread(threadIndex: number): Marker[] {
    while (this.threads.length <= threadIndex) {
      this.threads.push([]);
    }
    return this.threads[threadIndex];
  }

  // Returns the marker index.
  add(
    threadIndex: number,
    kind: Kind,
    id: string,
    start: number,
    end: number | null = null
  ): number {
    const key = kind === 'Trigger' ? 'trigger' : 'effect';
    const markers = this.thread(threadIndex);
    markers.push({
      start,
      end,
      name: kind,
      category: 0,
      threadId: threadIndex,
      data: { type: kind, [key]: this.stringTable.indexForString(id) } as any,
    });
    return markers.length - 1;
  }

  addRaw(threadIndex: number, start: number, end: number | null, data: any) {
    const markers = this.thread(threadIndex);
    markers.push({
      start,
      end,
      name: data.type,
      category: 0,
      threadId: threadIndex,
      data,
    });
    return markers.length - 1;
  }

  graph() {
    return computeCausalGraph(this.threads, schemas, this.stringTable);
  }
}

function primaryOf(graph: ReturnType<Builder['graph']>, t: number, m: number) {
  const [occurrence] = getMarkerOccurrences(graph, t, m);
  const causes = getCauses(graph, occurrence);
  if (!causes || causes.kind !== 'known') {
    return null;
  }
  return causes.primary;
}

describe('computeCausalGraph', () => {
  it('has no causal schema or occurrences for a profile without them', () => {
    const b = new Builder();
    b.addRaw(0, 0, null, { type: 'Plain', flow: 0 });
    const graph = computeCausalGraph(b.threads, [schemas[4]], b.stringTable);
    expect(graph.hasCausalSchema).toBe(false);
    expect(graph.occurrences).toHaveLength(0);
    expect(findCausalEntry(graph, 0, 5)).toBeNull();
  });

  it('pairs a trigger with an effect 1:1, across threads', () => {
    const b = new Builder();
    const trigger = b.add(0, 'Trigger', '00000000000000aa', 10);
    const effect = b.add(1, 'Effect', '00000000000000aa', 20, 30);
    const graph = b.graph();

    const [effectOcc] = getMarkerOccurrences(graph, 1, effect);
    const causes = getCauses(graph, effectOcc);
    expect(causes).toEqual({
      kind: 'known',
      primary: expect.objectContaining({
        threadIndex: 0,
        markerIndex: trigger,
        role: 'trigger',
        id: '00000000000000aa',
        time: 10,
      }),
      alternates: [],
    });
    const [triggerOcc] = getMarkerOccurrences(graph, 0, trigger);
    expect(getCauses(graph, triggerOcc)).toBeUndefined();
    expect(graph.effectsByTrigger.get(triggerOcc)).toEqual([
      { effect: effectOcc, isPrimary: true },
    ]);
  });

  it('uses the earliest trigger as primary when several are open (fan-in)', () => {
    const b = new Builder();
    // Insert out of time order on purpose.
    const t2 = b.add(0, 'Trigger', 'x', 12);
    const t1 = b.add(1, 'Trigger', 'x', 10);
    const t3 = b.add(0, 'Trigger', 'x', 14);
    const e = b.add(2, 'Effect', 'x', 20, 25);
    const graph = b.graph();

    const [effectOcc] = getMarkerOccurrences(graph, 2, e);
    const causes = getCauses(graph, effectOcc);
    if (causes?.kind !== 'known') {
      throw new Error('expected known causes');
    }
    expect([causes.primary.threadIndex, causes.primary.markerIndex]).toEqual([
      1,
      t1,
    ]);
    expect(causes.alternates.map((o) => o.markerIndex)).toEqual([t2, t3]);

    const [t2Occ] = getMarkerOccurrences(graph, 0, t2);
    expect(graph.effectsByTrigger.get(t2Occ)).toEqual([
      { effect: effectOcc, isPrimary: false },
    ]);
  });

  it('does not consume open triggers on a shared effect', () => {
    const b = new Builder();
    const trig = b.add(0, 'Trigger', 'x', 10);
    const s1 = b.add(1, 'SharedEffect', 'x', 20, 21);
    const s2 = b.add(2, 'SharedEffect', 'x', 22, 23);
    const e = b.add(1, 'Effect', 'x', 30, 31);
    const e2 = b.add(1, 'Effect', 'x', 40, 41);
    const graph = b.graph();

    expect(primaryOf(graph, 1, s1)?.markerIndex).toBe(trig);
    expect(primaryOf(graph, 2, s2)?.markerIndex).toBe(trig);
    // The consuming effect still sees the trigger, then clears it.
    expect(primaryOf(graph, 1, e)?.markerIndex).toBe(trig);
    const [e2Occ] = getMarkerOccurrences(graph, 1, e2);
    expect(getCauses(graph, e2Occ)).toEqual({ kind: 'unknown' });
    const [trigOcc] = getMarkerOccurrences(graph, 0, trig);
    expect(graph.effectsByTrigger.get(trigOcc)).toHaveLength(3);
  });

  it('gives an unknown cause after the trigger was consumed', () => {
    const b = new Builder();
    b.add(0, 'Trigger', 'x', 10);
    const e1 = b.add(1, 'Effect', 'x', 20, 21);
    const e2 = b.add(1, 'Effect', 'x', 30, 31);
    const graph = b.graph();
    expect(primaryOf(graph, 1, e1)).not.toBeNull();
    expect(primaryOf(graph, 1, e2)).toBeNull();
    const [e2Occ] = getMarkerOccurrences(graph, 1, e2);
    expect(getCauses(graph, e2Occ)).toEqual({ kind: 'unknown' });
  });

  it('gives an unknown cause to an effect before any trigger', () => {
    const b = new Builder();
    const e = b.add(1, 'Effect', 'x', 5, 6);
    b.add(0, 'Trigger', 'x', 10);
    const graph = b.graph();
    const [eOcc] = getMarkerOccurrences(graph, 1, e);
    expect(getCauses(graph, eOcc)).toEqual({ kind: 'unknown' });
  });

  it('handles id (pointer) reuse: each reuse pairs with its own trigger', () => {
    const b = new Builder();
    const t1 = b.add(0, 'Trigger', 'ptr', 10);
    const e1 = b.add(1, 'Effect', 'ptr', 12, 13);
    const t2 = b.add(0, 'Trigger', 'ptr', 20);
    const e2 = b.add(1, 'Effect', 'ptr', 22, 23);
    // A third effect with no new trigger must not pair with t1 or t2.
    const e3 = b.add(1, 'Effect', 'ptr', 30, 31);
    const graph = b.graph();
    expect(primaryOf(graph, 1, e1)?.markerIndex).toBe(t1);
    expect(primaryOf(graph, 1, e2)?.markerIndex).toBe(t2);
    expect(primaryOf(graph, 1, e3)).toBeNull();
    const [e2Occ] = getMarkerOccurrences(graph, 1, e2);
    expect(getCauses(graph, e2Occ)).toEqual(
      expect.objectContaining({ kind: 'known', alternates: [] })
    );
  });

  it('does not mix different ids', () => {
    const b = new Builder();
    b.add(0, 'Trigger', 'a', 10);
    const e = b.add(1, 'Effect', 'b', 20, 21);
    const graph = b.graph();
    expect(primaryOf(graph, 1, e)).toBeNull();
  });

  it('sorts triggers before effects on a time tie', () => {
    const b = new Builder();
    // The effect is listed first and on a lower thread index.
    const e = b.add(0, 'Effect', 'x', 10, 11);
    const t = b.add(1, 'Trigger', 'x', 10);
    const graph = b.graph();
    expect(primaryOf(graph, 0, e)).toEqual(
      expect.objectContaining({ threadIndex: 1, markerIndex: t })
    );
  });

  it('sorts shared effects before consuming effects on a time tie', () => {
    const b = new Builder();
    const e = b.add(0, 'Effect', 'x', 10, 11);
    const s = b.add(1, 'SharedEffect', 'x', 10, 11);
    const t = b.add(2, 'Trigger', 'x', 5);
    const graph = b.graph();
    expect(primaryOf(graph, 1, s)?.markerIndex).toBe(t);
    expect(primaryOf(graph, 0, e)?.markerIndex).toBe(t);
  });

  it('uses the marker start time for effects, not the end', () => {
    const b = new Builder();
    // Trigger at 15 is after the effect starts (10) but before it ends (20).
    b.add(0, 'Trigger', 'x', 15);
    const e = b.add(1, 'Effect', 'x', 10, 20);
    const graph = b.graph();
    expect(primaryOf(graph, 1, e)).toBeNull();
  });

  it('handles a marker with more than one causal field', () => {
    const b = new Builder();
    const first = b.add(0, 'Trigger', 'one', 1);
    const relay = b.addRaw(1, 5, 9, {
      type: 'Relay',
      cause: b.stringTable.indexForString('one'),
      next: b.stringTable.indexForString('two'),
    });
    const last = b.add(2, 'Effect', 'two', 12, 13);
    const graph = b.graph();

    const occs = getMarkerOccurrences(graph, 1, relay);
    expect(occs.map((o) => [o.fieldKey, o.role, o.id])).toEqual([
      ['cause', 'effect', 'one'],
      ['next', 'trigger', 'two'],
    ]);
    const causes = getCauses(graph, occs[0]);
    expect(causes).toEqual(
      expect.objectContaining({
        kind: 'known',
        primary: expect.objectContaining({ markerIndex: first }),
      })
    );
    expect(primaryOf(graph, 2, last)).toBe(occs[1]);
  });

  it('ignores markers whose causal field is missing', () => {
    const b = new Builder();
    b.addRaw(0, 1, null, { type: 'Trigger' });
    b.addRaw(0, 2, null, { type: 'Trigger', trigger: null });
    const graph = b.graph();
    expect(graph.occurrences).toHaveLength(0);
  });

  it('accepts a plain string array as the string source', () => {
    const b = new Builder();
    b.add(0, 'Trigger', 'x', 1);
    const e = b.add(1, 'Effect', 'x', 2, 3);
    const graph = computeCausalGraph(b.threads, schemas, b.stringArray);
    expect(primaryOf(graph, 1, e)).not.toBeNull();
  });

  it('scales to many markers', () => {
    const b = new Builder();
    const count = 100000;
    for (let i = 0; i < count; i++) {
      b.add(0, 'Trigger', 'id' + i, i);
      b.add(1, 'Effect', 'id' + i, i + 0.5, i + 0.75);
    }
    const graph = b.graph();
    expect(graph.occurrences).toHaveLength(2 * count);
    expect(findCausalEntry(graph, 1, 5000.6)?.time).toBe(5000.5);
  });
});

describe('findCausalEntry', () => {
  function setup() {
    const b = new Builder();
    // Thread 0: outer effect interval [10, 100], containing an inner effect
    // interval [40, 60] and a trigger at 70. Another effect interval [200, 300].
    const outer = b.add(0, 'Effect', 'o', 10, 100);
    const inner = b.add(0, 'Effect', 'i', 40, 60);
    const later = b.add(0, 'Effect', 'l', 200, 300);
    b.add(0, 'Trigger', 'out', 70);
    // Thread 1: an interval with instant effects inside, and one outside.
    const interval = b.add(1, 'Effect', 'p', 10, 50);
    const instantA = b.add(1, 'Effect', 'q', 20);
    const instantB = b.add(1, 'Effect', 'r', 30);
    const outside = b.add(1, 'Effect', 's', 5);
    return { b, outer, inner, later, interval, instantA, instantB, outside };
  }

  function entry(
    graph: ReturnType<Builder['graph']>,
    thread: number,
    time: number
  ) {
    const found = findCausalEntry(graph, thread, time);
    return found ? found.markerIndex : null;
  }

  it('returns null with no containing effect interval', () => {
    const { b } = setup();
    const graph = b.graph();
    expect(entry(graph, 0, 5)).toBeNull();
    expect(entry(graph, 0, 150)).toBeNull();
    expect(entry(graph, 0, 301)).toBeNull();
    expect(entry(graph, 7, 20)).toBeNull();
  });

  it('finds the innermost containing interval', () => {
    const { b, outer, inner, later } = setup();
    const graph = b.graph();
    expect(entry(graph, 0, 10)).toBe(outer);
    expect(entry(graph, 0, 39)).toBe(outer);
    expect(entry(graph, 0, 40)).toBe(inner);
    expect(entry(graph, 0, 60)).toBe(inner);
    // After the inner interval ended, we are back in the outer one.
    expect(entry(graph, 0, 70)).toBe(outer);
    expect(entry(graph, 0, 100)).toBe(outer);
    expect(entry(graph, 0, 250)).toBe(later);
  });

  it('prefers the latest instant effect nested in the interval', () => {
    const { b, interval, instantA, instantB } = setup();
    const graph = b.graph();
    expect(entry(graph, 1, 15)).toBe(interval);
    expect(entry(graph, 1, 20)).toBe(instantA);
    expect(entry(graph, 1, 29)).toBe(instantA);
    expect(entry(graph, 1, 45)).toBe(instantB);
  });

  it('does not use an instant effect from before the interval', () => {
    const { b, interval, outside } = setup();
    const graph = b.graph();
    expect(entry(graph, 1, 5)).toBeNull();
    expect(outside).not.toBe(interval);
    // At 10 the interval starts; the instant at 5 is outside it.
    expect(entry(graph, 1, 10)).toBe(interval);
  });

  it('ignores triggers and treats shared effects as effect fields', () => {
    const b = new Builder();
    b.add(0, 'Trigger', 'a', 0, 100);
    const shared = b.add(0, 'SharedEffect', 'b', 10, 20);
    const graph = b.graph();
    expect(entry(graph, 0, 5)).toBeNull();
    expect(entry(graph, 0, 15)).toBe(shared);
  });

  it('treats incomplete interval markers as extending forever', () => {
    const b = new Builder();
    const m = b.add(0, 'Effect', 'a', 10);
    b.thread(0)[m].incomplete = true;
    const graph = b.graph();
    expect(entry(graph, 0, 1e9)).toBe(m);
  });
});
