/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The backward critical-path walk over a causal graph. Pure: it only needs the
 * graph from `computeCausalGraph`, so it can be tested without a store. All
 * times are in the same unit and origin as the marker times that went into the
 * graph (absolute milliseconds).
 *
 * An effect on a thread starts once two things are true: its trigger has
 * arrived, and the thread is free. So between the trigger and the start of the
 * effect, whatever ran on the effect's thread delayed it.
 *
 * Starting at (thread, time), the walk repeats:
 *   entry = findCausalEntry(thread, time)
 *   none            -> "root" (zero length, at `time`), stop. We do not know
 *                     that the path waited since the profile start, so nothing
 *                     is added to the totals.
 *   running segment   entry.time .. time on the thread, labelled with entry
 *   cause unknown   -> if the entry is nested in another effect-carrying
 *                     interval on the thread, it ran synchronously inside it:
 *                     continue from that interval, with no wait. Otherwise
 *                     "unknown-cause" (zero length, at entry.time), stop
 *   wait segment      cause.time .. entry.time, from the cause's thread to the
 *                     entry's thread. By default, the work that ran on the
 *                     entry's thread in that span is added as running segments
 *                     flagged `blocking`, one per top-level effect-carrying
 *                     interval (clipped to the span), and only the rest of the
 *                     span counts as waiting. That work includes the remainder
 *                     of the task that emitted the trigger, when it is on the
 *                     same thread.
 *                     Then continue from (cause thread, cause time) with the
 *                     primary cause only.
 *
 * With `follow: 'causal'` the span is not broken down: the time the thread
 * spent in other work is the busy part of the wait.
 */

import {
  findCausalEntry,
  findEnclosingCausalInterval,
  getTopLevelIntervalsInRange,
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
  // running only: this work ran on the thread between the trigger of a later
  // effect on the path and its start, and so delayed it.
  blocking?: boolean;
  // running only: the entry has no known trigger but is nested in another
  // effect-carrying interval, which the next older running segment is in.
  nestedUnknownCause?: boolean;
  // unknown-cause only, when known: how long after the start of the data
  // recorded for its process the effect started.
  msAfterRecordingStart?: number;
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
  // Same, but the effect is so close to the start of the data recorded for its
  // process that its trigger was most likely recorded before that and lost.
  | 'recording-start'
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
  // Per thread, when the data recorded for the thread's process starts (a
  // profiler buffer that filled up drops its oldest data), or null if unknown.
  recordingStartByThread?: ReadonlyArray<number | null>;
  // 'blocking' (the default) adds the work that ran on an effect's thread
  // between its trigger and its start to the path. 'causal' only reports how
  // long that was.
  follow?: CriticalPathFollow;
};

export type CriticalPathFollow = 'blocking' | 'causal';

// An effect with no trigger that starts within this many milliseconds of the
// start of its process's recorded data stops the walk with 'recording-start'.
export const RECORDING_START_WINDOW_MS = 100;

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
  {
    maxDepth,
    profileStart,
    recordingStartByThread,
    follow = 'blocking',
  }: CriticalPathOptions
): CriticalPathWalk {
  const reversed: CriticalPathRawSegment[] = [];
  const visited = new Set<string>();
  let threadIndex = startThreadIndex;
  let time = startTime;
  let stopReason: CriticalPathStopReason = 'max-depth';
  let nextEntry: CausalOccurrence | null = null;
  for (let depth = 0; ; depth++) {
    if (depth >= maxDepth) {
      stopReason = 'max-depth';
      break;
    }

    const entry = nextEntry ?? findCausalEntry(graph, threadIndex, time);
    nextEntry = null;
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
      const outer = findEnclosingCausalInterval(graph, entry);
      if (outer !== null) {
        reversed[reversed.length - 1].nestedUnknownCause = true;
        nextEntry = outer;
        time = entry.time;
        continue;
      }
      const recordingStart = recordingStartByThread?.[entry.threadIndex];
      const msAfterRecordingStart =
        recordingStart === null || recordingStart === undefined
          ? undefined
          : entry.time - recordingStart;
      reversed.push({
        kind: 'unknown-cause',
        threadIndex,
        start: entry.time,
        end: entry.time,
        entryMarker: ref(entry),
        ...(msAfterRecordingStart === undefined
          ? {}
          : { msAfterRecordingStart }),
      });
      stopReason =
        msAfterRecordingStart !== undefined &&
        msAfterRecordingStart <= RECORDING_START_WINDOW_MS
          ? 'recording-start'
          : 'unknown-cause';
      break;
    }

    const primary = causes.primary;
    const waitStart = Math.min(primary.time, entry.time);
    let busyMs;
    let accountedMs;
    if (follow === 'blocking') {
      // The work that ran on the thread while the effect was waiting to start,
      // newest first. This includes the part of the entry's own task that ran
      // before the entry, when the entry is nested in one.
      const blockers = getTopLevelIntervalsInRange(
        graph,
        entry.threadIndex,
        waitStart,
        entry.time
      );
      accountedMs = 0;
      for (let i = blockers.length - 1; i >= 0; i--) {
        const blocker = blockers[i];
        const start = Math.max(blocker.time, waitStart);
        const end = Math.min(blocker.end as number, entry.time);
        if (end > start) {
          reversed.push({
            kind: 'running',
            threadIndex: entry.threadIndex,
            start,
            end,
            entryMarker: ref(blocker),
            blocking: true,
          });
          accountedMs += end - start;
        }
      }
      busyMs = 0;
    } else {
      busyMs = getBusyTime(
        graph,
        entry.threadIndex,
        waitStart,
        entry.time,
        entry.time
      );
      accountedMs = busyMs;
    }
    reversed.push({
      kind: 'wait',
      threadIndex: entry.threadIndex,
      start: waitStart,
      end: entry.time,
      entryMarker: ref(entry),
      triggerMarker: ref(primary),
      effectMarker: ref(entry),
      sourceThreadIndex: primary.threadIndex,
      alternateCauseCount: causes.alternates.length,
      busyMs,
      idleMs: Math.max(0, entry.time - waitStart - accountedMs),
    });

    if (!(primary.time < time)) {
      stopReason = 'non-decreasing-time';
      break;
    }
    threadIndex = primary.threadIndex;
    time = primary.time;
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
