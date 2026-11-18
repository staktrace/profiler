/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Selectors for the critical path shown in the timeline: the backward walk
 * over causal links from the marker chosen with `changeCriticalPathTarget`.
 */

import { getProfile, getProfileRootRange } from './profile';
import { getCriticalPathFocus, getCriticalPathTarget } from './url-state';
import {
  setCriticalPathSampleRangesProvider,
  type CriticalPathSampleRanges,
} from './critical-path-samples';
import {
  computeCausalDataFromState,
  getCriticalPathWalkStart,
  type CausalData,
} from 'firefox-profiler/profile-query/formatters/marker-causal';
import {
  walkCriticalPath,
  type CriticalPathWalk,
} from 'firefox-profiler/profile-query/critical-path';

import type {
  CriticalPathTarget,
  Marker,
  Profile,
  Selector,
  State,
  ThreadIndex,
} from 'firefox-profiler/types';

// The walk in the timeline is not meant to be cut short. This only bounds the
// work on a pathological profile.
const MAX_DEPTH = 1000000;

export type TimelineCriticalPath = {
  readonly target: CriticalPathTarget;
  readonly targetMarker: Marker;
  readonly walk: CriticalPathWalk;
  // Per thread, the full marker list that the walk's marker indexes refer to.
  readonly markerLists: ReadonlyArray<ReadonlyArray<Marker>>;
  // Whether any marker schema has a causal field.
  readonly hasCausalSchema: boolean;
};

// The causal graph spans every thread, so it is computed once per profile
// object and only when a critical path is first asked for.
let _causalDataProfile: Profile | null = null;
let _causalData: CausalData | null = null;

export function getCausalData(state: State): CausalData {
  const profile = getProfile(state);
  if (_causalData === null || _causalDataProfile !== profile) {
    _causalData = computeCausalDataFromState(state);
    _causalDataProfile = profile;
  }
  return _causalData;
}

let _lastCausalData: CausalData | null = null;
let _lastTarget: CriticalPathTarget | null = null;
let _lastCriticalPath: TimelineCriticalPath | null = null;

/**
 * The critical path to the target marker, or null if there is no target or it
 * does not exist in this profile (for example a URL from another profile).
 */
export const getTimelineCriticalPath: Selector<TimelineCriticalPath | null> = (
  state
) => {
  const target = getCriticalPathTarget(state);
  if (target === null) {
    return null;
  }
  const data = getCausalData(state);
  if (data === _lastCausalData && target === _lastTarget) {
    return _lastCriticalPath;
  }

  let criticalPath: TimelineCriticalPath | null = null;
  const targetMarker =
    data.markerLists[target.threadIndex]?.[target.markerIndex];
  if (targetMarker !== undefined) {
    const rootRange = getProfileRootRange(state);
    const walk = walkCriticalPath(
      data.graph,
      target.threadIndex,
      getCriticalPathWalkStart(targetMarker, rootRange.end),
      {
        maxDepth: MAX_DEPTH,
        profileStart: rootRange.start,
        recordingStartByThread: data.recordingStartByThread,
      }
    );
    criticalPath = {
      target,
      targetMarker,
      walk,
      markerLists: data.markerLists,
      hasCausalSchema: data.graph.hasCausalSchema,
    };
  }

  _lastCausalData = data;
  _lastTarget = target;
  _lastCriticalPath = criticalPath;
  return criticalPath;
};

/**
 * Whether the panels are focused on the critical path: only the samples taken
 * while a thread was running on the path are kept.
 */
export const getIsCriticalPathFocused: Selector<boolean> = (state) =>
  getCriticalPathFocus(state) && getTimelineCriticalPath(state) !== null;

const _rangesByPath = new WeakMap<
  TimelineCriticalPath,
  CriticalPathSampleRanges
>();

export function computeCriticalPathSampleRanges(
  criticalPath: TimelineCriticalPath
): CriticalPathSampleRanges {
  const byThread = new Map<ThreadIndex, Array<[number, number]>>();
  for (const segment of criticalPath.walk.segments) {
    if (segment.kind !== 'running' || !(segment.end > segment.start)) {
      continue;
    }
    let ranges = byThread.get(segment.threadIndex);
    if (ranges === undefined) {
      ranges = [];
      byThread.set(segment.threadIndex, ranges);
    }
    ranges.push([segment.start, segment.end]);
  }

  const result: CriticalPathSampleRanges = new Map();
  for (const [threadIndex, ranges] of byThread) {
    ranges.sort((a, b) => a[0] - b[0]);
    const flat: number[] = [];
    for (const [start, end] of ranges) {
      if (flat.length > 0 && start <= flat[flat.length - 1]) {
        flat[flat.length - 1] = Math.max(flat[flat.length - 1], end);
      } else {
        flat.push(start, end);
      }
    }
    result.set(threadIndex, Float64Array.from(flat));
  }
  return result;
}

/**
 * The sample ranges of the path in the timeline, or null if there is none.
 */
export const getCriticalPathSampleRanges: Selector<
  CriticalPathSampleRanges | null
> = (state) => {
  const criticalPath = getTimelineCriticalPath(state);
  if (criticalPath === null) {
    return null;
  }
  let ranges = _rangesByPath.get(criticalPath);
  if (ranges === undefined) {
    ranges = computeCriticalPathSampleRanges(criticalPath);
    _rangesByPath.set(criticalPath, ranges);
  }
  return ranges;
};

/**
 * The threads that ran on the path, for selecting them together.
 */
const _noThreadIndexes = new Set<ThreadIndex>();
const _threadIndexesByRanges = new WeakMap<
  CriticalPathSampleRanges,
  Set<ThreadIndex>
>();

export const getCriticalPathThreadIndexes: Selector<Set<ThreadIndex>> = (
  state
) => {
  const ranges = getCriticalPathSampleRanges(state);
  if (ranges === null) {
    return _noThreadIndexes;
  }
  let threadIndexes = _threadIndexesByRanges.get(ranges);
  if (threadIndexes === undefined) {
    threadIndexes = new Set(ranges.keys());
    _threadIndexesByRanges.set(ranges, threadIndexes);
  }
  return threadIndexes;
};

// The per-thread selectors cannot import this module, which uses them to get
// the markers of every thread. Hand them the ranges this way instead.
setCriticalPathSampleRangesProvider(getCriticalPathSampleRanges);
