/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Causal links between markers.
 *
 * Marker schema fields with the formats `causal-trigger-id`, `causal-effect-id`
 * and `causal-shared-effect-id` express explicit cause/effect links between
 * markers, on any thread of any process. The value of such a field is a 64-bit
 * id, stored as a hex string in the string table (like `flow-id`).
 *
 * This module is pure: it works on plain data (per-thread derived marker
 * arrays, the marker schema list, and a string table) and has no dependency on
 * the Redux store.
 *
 * Pairing rule. For each id X, take every trigger and effect occurrence in the
 * whole profile, ordered by marker start time. On a time tie, triggers sort
 * before shared effects, which sort before (consuming) effects. Keep a list
 * open(X) of triggers:
 *  - trigger: append to open(X).
 *  - effect: its causes are all of open(X), in time order. Then clear open(X).
 *  - shared effect: its causes are all of open(X). Do not clear.
 *  - an effect with an empty open(X) has an unknown cause. It is never paired
 *    with an older, already consumed trigger.
 * The primary cause is the earliest trigger of the list, the others are the
 * alternate causes.
 *
 * Nesting rule (same-thread hop). A trigger at time t on thread T was emitted
 * by the innermost interval marker on T that contains t and carries an effect
 * field. See `findCausalEntry`.
 */

import type { Marker } from 'firefox-profiler/types';
import type {
  MarkerSchema,
  MarkerFormatType,
} from 'firefox-profiler/types/markers';

export type CausalRole = 'trigger' | 'effect' | 'shared-effect';

/**
 * Something that can resolve a string table index to its string: a StringTable
 * or a plain array of strings (the profile's `shared.stringArray`).
 */
export type CausalStringSource =
  | { getString(index: number): string }
  | ReadonlyArray<string>;

/**
 * One causal field of one marker. A marker with several causal fields yields
 * several occurrences.
 */
export type CausalOccurrence = {
  // Position in `CausalGraph.occurrences`.
  occurrenceIndex: number;
  threadIndex: number;
  // Index into the marker array passed for this thread.
  markerIndex: number;
  // The schema field key this occurrence was read from.
  fieldKey: string;
  // The marker's start time. This is the time used for pairing.
  time: number;
  // The marker's end time. null for instant markers. Infinity for incomplete
  // interval markers (that have a start but no end yet).
  end: number | null;
  role: CausalRole;
  // The id, resolved through the string table, so that ids compare as strings.
  id: string;
};

export type CausalCauses =
  | {
      kind: 'known';
      // The earliest open trigger.
      primary: CausalOccurrence;
      // The other open triggers (fan-in), in time order. Empty in the 1:1 case.
      alternates: CausalOccurrence[];
    }
  | { kind: 'unknown' };

export type CausalEffectLink = {
  effect: CausalOccurrence;
  // Whether the trigger is the primary cause of this effect (as opposed to one
  // of its alternates).
  isPrimary: boolean;
};

export type CausalGraph = {
  // Every causal occurrence, in no particular order. Indexed by
  // `occurrenceIndex`.
  occurrences: CausalOccurrence[];
  // Per thread, the occurrences of that thread sorted by time (ties: by marker
  // index, then by occurrenceIndex).
  occurrencesByThread: CausalOccurrence[][];
  // Indexed by `occurrenceIndex`. For effect and shared-effect occurrences,
  // their resolved causes. undefined for triggers.
  causesByOccurrence: Array<CausalCauses | undefined>;
  // Reverse map. For every trigger occurrence that is the cause of at least one
  // effect, the effects it caused (primary or alternate), in effect time order.
  effectsByTrigger: Map<CausalOccurrence, CausalEffectLink[]>;
  // Per thread, markerIndex -> that marker's occurrences.
  occurrencesByMarker: Array<Map<number, CausalOccurrence[]>>;
  // Per thread, the data structures that findCausalEntry uses.
  entryIndexByThread: ThreadEntryIndex[];
  // Whether any schema has a causal field. When false, the profile is not
  // instrumented for causal links at all.
  hasCausalSchema: boolean;
};

type ThreadEntryIndex = {
  // Effect and shared-effect occurrences of interval markers, sorted by start
  // ascending, and by end descending on ties (outer first).
  intervals: CausalOccurrence[];
  // For each entry of `intervals`, the index of the enclosing interval at the
  // time it started (the nearest previous interval still open), or -1.
  parents: Int32Array;
  // Effect and shared-effect occurrences of instant markers, sorted by time.
  instants: CausalOccurrence[];
};

function roleFromFormat(
  format: MarkerFormatType | undefined
): CausalRole | null {
  switch (format) {
    case 'causal-trigger-id':
      return 'trigger';
    case 'causal-effect-id':
      return 'effect';
    case 'causal-shared-effect-id':
      return 'shared-effect';
    default:
      return null;
  }
}

export function isCausalFormat(format: MarkerFormatType | undefined): boolean {
  return roleFromFormat(format) !== null;
}

// Tie-breaking order at equal times: triggers first, then shared effects (they
// must see the triggers but must not be affected by a consuming effect at the
// same time), then consuming effects.
function roleRank(role: CausalRole): number {
  switch (role) {
    case 'trigger':
      return 0;
    case 'shared-effect':
      return 1;
    default:
      return 2;
  }
}

function compareForPairing(a: CausalOccurrence, b: CausalOccurrence): number {
  return (
    a.time - b.time ||
    roleRank(a.role) - roleRank(b.role) ||
    a.threadIndex - b.threadIndex ||
    a.markerIndex - b.markerIndex ||
    a.occurrenceIndex - b.occurrenceIndex
  );
}

function resolveString(source: CausalStringSource, index: number): string {
  if (Array.isArray(source)) {
    return (source as ReadonlyArray<string>)[index];
  }
  return (source as { getString(index: number): string }).getString(index);
}

/**
 * Compute the causal graph of a profile.
 *
 * @param markersPerThread For each thread, its full derived marker list. The
 *   position of a marker in its array is its `markerIndex`.
 * @param markerSchema The profile's marker schemas (`profile.meta.markerSchema`).
 * @param stringTable The string table used to resolve ids.
 */
export function computeCausalGraph(
  markersPerThread: ReadonlyArray<ReadonlyArray<Marker>>,
  markerSchema: ReadonlyArray<MarkerSchema>,
  stringTable: CausalStringSource
): CausalGraph {
  // Schema name -> its causal fields.
  const causalFieldsBySchema = new Map<
    string,
    Array<{ key: string; role: CausalRole }>
  >();
  for (const schema of markerSchema) {
    let fields: Array<{ key: string; role: CausalRole }> | undefined;
    for (const field of schema.fields) {
      const role = roleFromFormat(field.format);
      if (role !== null) {
        if (fields === undefined) {
          fields = [];
        }
        fields.push({ key: field.key, role });
      }
    }
    if (fields !== undefined) {
      causalFieldsBySchema.set(schema.name, fields);
    }
  }

  const occurrences: CausalOccurrence[] = [];
  const occurrencesByThread: CausalOccurrence[][] = [];
  const occurrencesByMarker: Array<Map<number, CausalOccurrence[]>> = [];
  const byId = new Map<string, CausalOccurrence[]>();

  for (
    let threadIndex = 0;
    threadIndex < markersPerThread.length;
    threadIndex++
  ) {
    const markers = markersPerThread[threadIndex];
    const threadOccurrences: CausalOccurrence[] = [];
    const threadByMarker = new Map<number, CausalOccurrence[]>();
    if (causalFieldsBySchema.size !== 0) {
      for (let markerIndex = 0; markerIndex < markers.length; markerIndex++) {
        const marker = markers[markerIndex];
        const data = marker.data;
        if (!data) {
          continue;
        }
        const fields = causalFieldsBySchema.get(data.type);
        if (fields === undefined) {
          continue;
        }
        for (const { key, role } of fields) {
          const value = (data as Record<string, unknown>)[key];
          if (typeof value !== 'number') {
            continue;
          }
          const id = resolveString(stringTable, value);
          if (typeof id !== 'string' || id === '') {
            continue;
          }
          let end: number | null = marker.end;
          if (end === null && marker.incomplete) {
            end = Infinity;
          }
          const occurrence: CausalOccurrence = {
            occurrenceIndex: occurrences.length,
            threadIndex,
            markerIndex,
            fieldKey: key,
            time: marker.start,
            end,
            role,
            id,
          };
          occurrences.push(occurrence);
          threadOccurrences.push(occurrence);
          const forMarker = threadByMarker.get(markerIndex);
          if (forMarker === undefined) {
            threadByMarker.set(markerIndex, [occurrence]);
          } else {
            forMarker.push(occurrence);
          }
          const forId = byId.get(id);
          if (forId === undefined) {
            byId.set(id, [occurrence]);
          } else {
            forId.push(occurrence);
          }
        }
      }
    }
    threadOccurrences.sort(
      (a, b) =>
        a.time - b.time ||
        a.markerIndex - b.markerIndex ||
        a.occurrenceIndex - b.occurrenceIndex
    );
    occurrencesByThread.push(threadOccurrences);
    occurrencesByMarker.push(threadByMarker);
  }

  // Pairing: one sort and one sweep per id.
  const causesByOccurrence: Array<CausalCauses | undefined> = new Array(
    occurrences.length
  );
  const effectsByTrigger = new Map<CausalOccurrence, CausalEffectLink[]>();
  const addLink = (
    trigger: CausalOccurrence,
    effect: CausalOccurrence,
    isPrimary: boolean
  ) => {
    const links = effectsByTrigger.get(trigger);
    if (links === undefined) {
      effectsByTrigger.set(trigger, [{ effect, isPrimary }]);
    } else {
      links.push({ effect, isPrimary });
    }
  };

  for (const list of byId.values()) {
    if (list.length > 1) {
      list.sort(compareForPairing);
    }
    let open: CausalOccurrence[] = [];
    for (const occurrence of list) {
      if (occurrence.role === 'trigger') {
        open.push(occurrence);
        continue;
      }
      if (open.length === 0) {
        causesByOccurrence[occurrence.occurrenceIndex] = { kind: 'unknown' };
        continue;
      }
      // The array is not mutated after this point (consuming effects start a
      // fresh array instead of clearing), so it can be shared with the result.
      const [primary, ...alternates] = open;
      causesByOccurrence[occurrence.occurrenceIndex] = {
        kind: 'known',
        primary,
        alternates,
      };
      addLink(primary, occurrence, true);
      for (const alternate of alternates) {
        addLink(alternate, occurrence, false);
      }
      if (occurrence.role === 'effect') {
        open = [];
      }
    }
  }

  // Per-thread index for nesting lookups.
  const entryIndexByThread = occurrencesByThread.map(
    (threadOccurrences): ThreadEntryIndex => {
      const intervals: CausalOccurrence[] = [];
      const instants: CausalOccurrence[] = [];
      for (const occurrence of threadOccurrences) {
        if (occurrence.role === 'trigger') {
          continue;
        }
        if (occurrence.end === null) {
          instants.push(occurrence);
        } else {
          intervals.push(occurrence);
        }
      }
      // `threadOccurrences` is sorted by time already, instants are in order.
      intervals.sort(
        (a, b) =>
          a.time - b.time ||
          (b.end as number) - (a.end as number) ||
          a.occurrenceIndex - b.occurrenceIndex
      );
      const parents = new Int32Array(intervals.length);
      const stack: number[] = [];
      for (let i = 0; i < intervals.length; i++) {
        const start = intervals[i].time;
        const end = intervals[i].end as number;
        // An interval that starts at the instant another one ends, and runs
        // past it, comes after it: it is not nested in it.
        while (
          stack.length > 0 &&
          ((intervals[stack[stack.length - 1]].end as number) < start ||
            (intervals[stack[stack.length - 1]].end as number) < end)
        ) {
          stack.pop();
        }
        parents[i] = stack.length > 0 ? stack[stack.length - 1] : -1;
        stack.push(i);
      }
      return { intervals, parents, instants };
    }
  );

  return {
    occurrences,
    occurrencesByThread,
    causesByOccurrence,
    effectsByTrigger,
    occurrencesByMarker,
    entryIndexByThread,
    hasCausalSchema: causalFieldsBySchema.size !== 0,
  };
}

/**
 * The resolved causes of an occurrence, or undefined if it is a trigger.
 */
export function getCauses(
  graph: CausalGraph,
  occurrence: CausalOccurrence
): CausalCauses | undefined {
  return graph.causesByOccurrence[occurrence.occurrenceIndex];
}

/**
 * The causal occurrences of one marker (empty if it has none).
 */
export function getMarkerOccurrences(
  graph: CausalGraph,
  threadIndex: number,
  markerIndex: number
): CausalOccurrence[] {
  return graph.occurrencesByMarker[threadIndex]?.get(markerIndex) ?? [];
}

/**
 * Find the latest causal entry point on a thread at or before `time`: the later
 * of
 *  (a) the start of the innermost interval marker containing `time` (both
 *      bounds inclusive) that carries an effect (or shared effect) field, and
 *  (b) the latest instant effect marker nested inside that interval, at or
 *      before `time`.
 * Returns the effect occurrence, or null if there is no interval carrying an
 * effect field that contains `time`. Instant effects that are not inside such
 * an interval are not entry points.
 *
 * Intervals are assumed to be well nested (the `isStackBased` contract). The
 * cost is a binary search plus a walk up the chain of enclosing intervals.
 */
export function findCausalEntry(
  graph: CausalGraph,
  threadIndex: number,
  time: number
): CausalOccurrence | null {
  const index = graph.entryIndexByThread[threadIndex];
  if (index === undefined) {
    return null;
  }
  const { intervals, parents, instants } = index;

  // Last interval with start <= time.
  let lo = 0;
  let hi = intervals.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (intervals[mid].time <= time) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  let candidate = lo - 1;
  while (candidate >= 0 && (intervals[candidate].end as number) < time) {
    candidate = parents[candidate];
  }
  if (candidate < 0) {
    return null;
  }
  const interval = intervals[candidate];

  // Last instant with time <= `time`.
  lo = 0;
  hi = instants.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (instants[mid].time <= time) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  if (lo > 0 && instants[lo - 1].time >= interval.time) {
    return instants[lo - 1];
  }
  return interval;
}
