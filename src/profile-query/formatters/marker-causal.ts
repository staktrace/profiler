/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Structured results for `marker cause` and `marker critical-path`.
 */

import {
  getProfile,
  getProfileRootRange,
  getMarkerSchema,
  getStringTable,
  getZeroAt,
} from 'firefox-profiler/selectors/profile';
import { getThreadSelectors } from 'firefox-profiler/selectors/per-thread';
import {
  computeCausalGraph,
  findCausalEntry,
  getCauses,
  getMarkerOccurrences,
  type CausalGraph,
  type CausalOccurrence,
} from 'firefox-profiler/profile-logic/causal-links';
import type { Marker } from 'firefox-profiler/types';
import type { Store } from '../../types/store';
import type { ThreadMap } from '../thread-map';
import type { MarkerMap } from '../marker-map';
import type { TimestampManager } from '../timestamps';
import { walkCriticalPath, type CriticalPathMarkerRef } from '../critical-path';
import type {
  CausalMarkerRef,
  CausalLinkEnd,
  MarkerCauseOccurrence,
  MarkerCauseResult,
  MarkerCriticalPathResult,
  CriticalPathSegment,
} from '../types';

/** The causal graph of a profile, and the marker lists its indexes refer to. */
export type CausalData = {
  graph: CausalGraph;
  // Per thread, the full derived marker list (the same one a MarkerIndex of
  // that thread indexes into).
  markerLists: ReadonlyArray<ReadonlyArray<Marker>>;
};

// Cap on the effects listed for one trigger, so that a trigger with a very
// large fan-out cannot flood the output.
export const MAX_EFFECTS_PER_TRIGGER = 50;

export const DEFAULT_CRITICAL_PATH_MAX_DEPTH = 50;

// How many markers are listed as the context of the root of a path.
export const MAX_ROOT_ENCLOSING_MARKERS = 3;

/**
 * The innermost interval markers of any type on a thread that contain `time`
 * (inclusive at both ends, like findCausalEntry), innermost first: latest
 * start, then shortest. A linear scan, as this runs once per walk.
 */
function findEnclosingMarkers(
  markers: ReadonlyArray<Marker>,
  time: number
): number[] {
  const found: number[] = [];
  for (let i = 0; i < markers.length; i++) {
    const { start, end } = markers[i];
    if (end !== null && start <= time && time <= end) {
      found.push(i);
    }
  }
  found.sort((a, b) => {
    const ma = markers[a];
    const mb = markers[b];
    return (
      mb.start - ma.start ||
      (ma.end as number) - ma.start - ((mb.end as number) - mb.start) ||
      a - b
    );
  });
  return found.slice(0, MAX_ROOT_ENCLOSING_MARKERS);
}

/**
 * Compute the graph over every thread of the profile. This spans all threads,
 * so a caller computes it once per loaded profile and keeps it.
 */
export function computeCausalData(store: Store): CausalData {
  const state = store.getState();
  const profile = getProfile(state);
  const markerLists = profile.threads.map((_, threadIndex) =>
    getThreadSelectors(new Set([threadIndex])).getFullMarkerList(state)
  );
  const graph = computeCausalGraph(
    markerLists,
    getMarkerSchema(state),
    getStringTable(state)
  );
  return { graph, markerLists };
}

type Resolver = {
  store: Store;
  data: CausalData;
  markerMap: MarkerMap;
  threadMap: ThreadMap;
  timestampManager: TimestampManager;
  zeroAt: number;
  threadName(threadIndex: number): string;
  markerRef(ref: CriticalPathMarkerRef): CausalMarkerRef;
  linkEnd(occurrence: CausalOccurrence): CausalLinkEnd;
};

function makeResolver(
  store: Store,
  data: CausalData,
  markerMap: MarkerMap,
  threadMap: ThreadMap,
  timestampManager: TimestampManager
): Resolver {
  const state = store.getState();
  const zeroAt = getZeroAt(state);
  const threadNames = new Map<number, string>();
  const threadName = (threadIndex: number) => {
    let name = threadNames.get(threadIndex);
    if (name === undefined) {
      name = getThreadSelectors(new Set([threadIndex])).getFriendlyThreadName(
        state
      );
      threadNames.set(threadIndex, name);
    }
    return name;
  };
  const markerRef = ({
    threadIndex,
    markerIndex,
  }: CriticalPathMarkerRef): CausalMarkerRef => {
    const marker = data.markerLists[threadIndex][markerIndex];
    return {
      markerHandle: markerMap.handleForMarker(
        new Set([threadIndex]),
        markerIndex
      ),
      threadHandle: threadMap.handleForThreadIndex(threadIndex),
      friendlyThreadName: threadName(threadIndex),
      name: marker.name,
      start: marker.start - zeroAt,
      end: marker.end !== null ? marker.end - zeroAt : null,
    };
  };
  return {
    store,
    data,
    markerMap,
    threadMap,
    timestampManager,
    zeroAt,
    threadName,
    markerRef,
    linkEnd: (occurrence) => ({
      marker: markerRef(occurrence),
      fieldKey: occurrence.fieldKey,
      role: occurrence.role,
    }),
  };
}

/**
 * Resolve a handle to a (thread, marker) of the graph's marker lists. Handles
 * of a merged multi-thread selection index a different list, so they are
 * rejected rather than silently misread.
 */
function resolveMarker(
  data: CausalData,
  markerMap: MarkerMap,
  markerHandle: string
): { threadIndex: number; markerIndex: number; marker: Marker } {
  const { threadIndexes, markerIndex } =
    markerMap.markerForHandle(markerHandle);
  if (threadIndexes.size !== 1) {
    throw new Error(
      `Marker ${markerHandle} comes from a merged multi-thread view; causal ` +
        `links are per thread. List the markers of a single thread to get a ` +
        `handle that can be used here.`
    );
  }
  const [threadIndex] = threadIndexes;
  const marker = data.markerLists[threadIndex]?.[markerIndex];
  if (!marker) {
    throw new Error(`Marker ${markerHandle} not found`);
  }
  return { threadIndex, markerIndex, marker };
}

export function collectMarkerCause(
  store: Store,
  data: CausalData,
  markerMap: MarkerMap,
  threadMap: ThreadMap,
  timestampManager: TimestampManager,
  markerHandle: string
): MarkerCauseResult {
  const { threadIndex, markerIndex, marker } = resolveMarker(
    data,
    markerMap,
    markerHandle
  );
  const r = makeResolver(store, data, markerMap, threadMap, timestampManager);
  const { graph } = data;

  const occurrences: MarkerCauseOccurrence[] = [];
  for (const occurrence of getMarkerOccurrences(
    graph,
    threadIndex,
    markerIndex
  )) {
    const item: MarkerCauseOccurrence = {
      fieldKey: occurrence.fieldKey,
      role: occurrence.role,
      id: occurrence.id,
    };
    if (occurrence.role === 'trigger') {
      const links = graph.effectsByTrigger.get(occurrence) ?? [];
      item.effects = links
        .slice(0, MAX_EFFECTS_PER_TRIGGER)
        .map(({ effect, isPrimary }) => ({
          ...r.linkEnd(effect),
          isPrimary,
        }));
      if (links.length > MAX_EFFECTS_PER_TRIGGER) {
        item.effectCount = links.length;
      }
    } else {
      const causes = getCauses(graph, occurrence);
      if (causes === undefined || causes.kind === 'unknown') {
        item.causes = { kind: 'unknown' };
      } else {
        item.causes = {
          kind: 'known',
          primary: r.linkEnd(causes.primary),
          alternates: causes.alternates.map((a) => r.linkEnd(a)),
        };
      }
    }
    occurrences.push(item);
  }

  const entry = findCausalEntry(graph, threadIndex, marker.start);
  const enclosing =
    entry !== null && entry.markerIndex !== markerIndex
      ? r.linkEnd(entry)
      : null;

  return {
    type: 'marker-cause',
    threadHandle: threadMap.handleForThreadIndex(threadIndex),
    friendlyThreadName: r.threadName(threadIndex),
    markerHandle,
    markerIndex,
    markerName: marker.name,
    start: marker.start - r.zeroAt,
    end: marker.end !== null ? marker.end - r.zeroAt : null,
    hasCausalSchema: graph.hasCausalSchema,
    occurrences,
    enclosing,
  };
}

export const NO_CAUSAL_SCHEMA_WARNING =
  'This profile has no marker schema with a causal field (causal-trigger-id, ' +
  'causal-effect-id or causal-shared-effect-id): it was recorded without ' +
  'causal markers, so there are no links to follow.';

export function collectMarkerCriticalPath(
  store: Store,
  data: CausalData,
  markerMap: MarkerMap,
  threadMap: ThreadMap,
  timestampManager: TimestampManager,
  markerHandle: string,
  maxDepth: number
): MarkerCriticalPathResult {
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new Error(`max depth must be a positive integer, got ${maxDepth}`);
  }
  const { threadIndex, markerIndex, marker } = resolveMarker(
    data,
    markerMap,
    markerHandle
  );
  const r = makeResolver(store, data, markerMap, threadMap, timestampManager);
  const { graph } = data;
  const rootRange = getProfileRootRange(store.getState());

  // Where the walk begins: the end of the marker. An instant marker ends where
  // it starts, and an incomplete interval has not ended, so it is taken to run
  // to the end of the profile.
  let walkTime = marker.end ?? marker.start;
  if (marker.end === null && marker.incomplete) {
    walkTime = Math.max(marker.start, rootRange.end);
  }

  const walk = walkCriticalPath(graph, threadIndex, walkTime, {
    maxDepth,
    profileStart: rootRange.start,
  });

  const rel = (time: number) => time - r.zeroAt;
  const segments: CriticalPathSegment[] = walk.segments.map((raw) => {
    const segment: CriticalPathSegment = {
      kind: raw.kind,
      threadHandle: threadMap.handleForThreadIndex(raw.threadIndex),
      friendlyThreadName: r.threadName(raw.threadIndex),
      start: rel(raw.start),
      end: rel(raw.end),
      duration: raw.end - raw.start,
      startName: timestampManager.nameForTimestamp(raw.start),
      endName: timestampManager.nameForTimestamp(raw.end),
    };
    if (raw.entryMarker) {
      segment.entryMarker = r.markerRef(raw.entryMarker);
    }
    if (raw.nestedUnknownCause) {
      segment.nestedUnknownCause = true;
    }
    if (raw.kind === 'wait') {
      segment.triggerMarker = r.markerRef(raw.triggerMarker!);
      segment.effectMarker = r.markerRef(raw.effectMarker!);
      segment.sourceThreadHandle = threadMap.handleForThreadIndex(
        raw.sourceThreadIndex!
      );
      segment.sourceThreadName = r.threadName(raw.sourceThreadIndex!);
      segment.alternateCauseCount = raw.alternateCauseCount;
      segment.busyMs = raw.busyMs;
      segment.idleMs = raw.idleMs;
    }
    if (raw.kind === 'root') {
      segment.enclosingMarkers = findEnclosingMarkers(
        data.markerLists[raw.threadIndex],
        raw.start
      ).map((markerIndex) =>
        r.markerRef({ threadIndex: raw.threadIndex, markerIndex })
      );
    }
    return segment;
  });

  const totalsByThread = walk.totalsByThread.map((t) => ({
    threadHandle: threadMap.handleForThreadIndex(t.threadIndex),
    friendlyThreadName: r.threadName(t.threadIndex),
    running: t.running,
    waitBusy: t.waitBusy,
    waitIdle: t.waitIdle,
    total: t.total,
  }));
  const { running, waitBusy, waitIdle } = walk.totalsByKind;

  const warnings: string[] = [];
  if (!graph.hasCausalSchema) {
    warnings.push(NO_CAUSAL_SCHEMA_WARNING);
  }

  return {
    type: 'marker-critical-path',
    threadHandle: threadMap.handleForThreadIndex(threadIndex),
    friendlyThreadName: r.threadName(threadIndex),
    markerHandle,
    markerIndex,
    markerName: marker.name,
    start: rel(marker.start),
    end: marker.end !== null ? rel(marker.end) : null,
    walkStart: rel(walkTime),
    maxDepth,
    segments,
    totalMs: running + waitBusy + waitIdle,
    totalsByKind: { running, waitBusy, waitIdle },
    totalsByThread,
    stopReason: walk.stopReason,
    hasCausalSchema: graph.hasCausalSchema,
    warnings,
  };
}
