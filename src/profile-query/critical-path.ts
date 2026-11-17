/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The backward critical-path walk over a causal graph. Pure: it only needs the
 * graph from `computeCausalGraph`, so it can be tested without a store. All
 * times are in the same unit and origin as the marker times that went into the
 * graph (absolute milliseconds).
 *
 * Starting at (thread, time), the walk repeats:
 *   entry = findCausalEntry(thread, time)
 *   none            -> "root" (zero length, at `time`), stop. We do not know
 *                     that the path waited since the profile start, so nothing
 *                     is added to the totals.
 *   running segment   entry.time .. time on the thread, labelled with entry
 *   cause unknown   -> "unknown-cause" (zero length, at entry.time), stop
 *   wait segment      cause.time .. entry.time, from the cause's thread to the
 *                     entry's thread, then continue from (cause thread,
 *                     cause time) with the primary cause only.
 */

import {
  findCausalEntry,
  getBusyTime,
  getCauses,
  type CausalGraph,
  type CausalOccurrence,
} from 'firefox-profiler/profile-logic/causal-links';

export type CriticalPathMarkerRef = {
  threadIndex: number;
  markerIndex: number;
};

export type CriticalPathSegmentKind =
  | 'running'
  | 'wait'
  | 'root'
  | 'unknown-cause';

export type CriticalPathRawSegment = {
  kind: CriticalPathSegmentKind;
  // The thread the segment is on. For a wait this is the destination thread:
  // the thread that was waiting to be woken up.
  threadIndex: number;
  start: number;
  end: number;
  // running and unknown-cause: the entry effect marker. wait: the effect marker
  // the wait ends in (same as `effectMarker`). root: absent.
  entryMarker?: CriticalPathMarkerRef;
  // Waits only.
  triggerMarker?: CriticalPathMarkerRef;
  effectMarker?: CriticalPathMarkerRef;
  sourceThreadIndex?: number;
  // How many other triggers were coalesced into the same effect. Not walked.
  alternateCauseCount?: number;
  // How much of the wait the destination thread spent inside other top-level
  // effect-carrying intervals (queued behind other work), and the rest.
  busyMs?: number;
  idleMs?: number;
};

export type CriticalPathStopReason =
  // No effect-carrying interval contains the position: the root of the chain.
  | 'root'
  // The entry effect has no open trigger.
  | 'unknown-cause'
  | 'max-depth'
  // The walk reached (or went before) the profile start.
  | 'profile-start'
  // The next position's time did not strictly decrease.
  | 'non-decreasing-time'
  // The entry marker was already visited (a cycle).
  | 'revisited-marker';

export type CriticalPathKindTotals = {
  running: number;
  waitBusy: number;
  waitIdle: number;
};

export type CriticalPathThreadTotals = CriticalPathKindTotals & {
  threadIndex: number;
  total: number;
};

export type CriticalPathWalk = {
  // In chronological order.
  segments: CriticalPathRawSegment[];
  stopReason: CriticalPathStopReason;
  totalsByKind: CriticalPathKindTotals;
  // Sorted by total, descending.
  totalsByThread: CriticalPathThreadTotals[];
};

export type CriticalPathOptions = {
  // The maximum number of causal hops (waits) to follow.
  maxDepth: number;
  // The lower bound of the walk, normally the start of the profile.
  profileStart: number;
};

function ref(occurrence: CausalOccurrence): CriticalPathMarkerRef {
  return {
    threadIndex: occurrence.threadIndex,
    markerIndex: occurrence.markerIndex,
  };
}

export function walkCriticalPath(
  graph: CausalGraph,
  startThreadIndex: number,
  startTime: number,
  { maxDepth, profileStart }: CriticalPathOptions
): CriticalPathWalk {
  const reversed: CriticalPathRawSegment[] = [];
  const visited = new Set<string>();
  let threadIndex = startThreadIndex;
  let time = startTime;
  let stopReason: CriticalPathStopReason = 'max-depth';

  for (let depth = 0; ; depth++) {
    if (depth >= maxDepth) {
      stopReason = 'max-depth';
      break;
    }

    const entry = findCausalEntry(graph, threadIndex, time);
    if (entry === null) {
      reversed.push({
        kind: 'root',
        threadIndex,
        start: time,
        end: time,
      });
      stopReason = 'root';
      break;
    }

    const visitKey = `${entry.threadIndex}:${entry.markerIndex}`;
    if (visited.has(visitKey)) {
      stopReason = 'revisited-marker';
      break;
    }
    visited.add(visitKey);

    reversed.push({
      kind: 'running',
      threadIndex,
      start: entry.time,
      end: time,
      entryMarker: ref(entry),
    });

    const causes = getCauses(graph, entry);
    if (causes === undefined || causes.kind === 'unknown') {
      reversed.push({
        kind: 'unknown-cause',
        threadIndex,
        start: entry.time,
        end: entry.time,
        entryMarker: ref(entry),
      });
      stopReason = 'unknown-cause';
      break;
    }

    const cause = causes.primary;
    const waitStart = Math.min(cause.time, entry.time);
    const busyMs = getBusyTime(
      graph,
      entry.threadIndex,
      waitStart,
      entry.time,
      entry.time
    );
    reversed.push({
      kind: 'wait',
      threadIndex: entry.threadIndex,
      start: waitStart,
      end: entry.time,
      entryMarker: ref(entry),
      triggerMarker: ref(cause),
      effectMarker: ref(entry),
      sourceThreadIndex: cause.threadIndex,
      alternateCauseCount: causes.alternates.length,
      busyMs,
      idleMs: Math.max(0, entry.time - waitStart - busyMs),
    });

    if (!(cause.time < time)) {
      stopReason = 'non-decreasing-time';
      break;
    }
    threadIndex = cause.threadIndex;
    time = cause.time;
    if (time <= profileStart) {
      stopReason = 'profile-start';
      break;
    }
  }

  const segments = reversed.reverse();
  return {
    segments,
    stopReason,
    ...computeTotals(segments),
  };
}

function computeTotals(segments: CriticalPathRawSegment[]): {
  totalsByKind: CriticalPathKindTotals;
  totalsByThread: CriticalPathThreadTotals[];
} {
  const totalsByKind: CriticalPathKindTotals = {
    running: 0,
    waitBusy: 0,
    waitIdle: 0,
  };
  const byThread = new Map<number, CriticalPathThreadTotals>();
  for (const segment of segments) {
    let totals = byThread.get(segment.threadIndex);
    if (totals === undefined) {
      totals = {
        threadIndex: segment.threadIndex,
        running: 0,
        waitBusy: 0,
        waitIdle: 0,
        total: 0,
      };
      byThread.set(segment.threadIndex, totals);
    }
    const duration = segment.end - segment.start;
    const add = (key: keyof CriticalPathKindTotals, amount: number) => {
      totalsByKind[key] += amount;
      (totals as CriticalPathThreadTotals)[key] += amount;
      (totals as CriticalPathThreadTotals).total += amount;
    };
    switch (segment.kind) {
      case 'running':
        add('running', duration);
        break;
      case 'wait':
        add('waitBusy', segment.busyMs ?? 0);
        add('waitIdle', segment.idleMs ?? 0);
        break;
      case 'root':
      case 'unknown-cause':
        break;
      default:
        throw new Error(`Unexpected segment kind ${segment.kind as string}`);
    }
  }
  return {
    totalsByKind,
    totalsByThread: [...byThread.values()].sort(
      (a, b) => b.total - a.total || a.threadIndex - b.threadIndex
    ),
  };
}
