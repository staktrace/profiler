/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The part of the critical path focus that the per-thread selectors need:
 * which samples of a thread were taken while it was running on the path.
 *
 * The path itself is computed in ./critical-path from the markers of every
 * thread, so that module depends on the per-thread selectors and cannot be
 * imported by them. It registers itself here instead.
 */

import { getCriticalPathFocus } from './url-state';
import { computeTimeColumnForRawSamplesTable } from 'firefox-profiler/profile-logic/profile-data';

import type {
  RawThread,
  Selector,
  State,
  ThreadIndex,
} from 'firefox-profiler/types';

/**
 * Per thread, the time ranges in which the thread was running on the path, as
 * a flat array of [start, end, start, end, ...], sorted and not overlapping.
 */
export type CriticalPathSampleRanges = Map<ThreadIndex, Float64Array>;

let _provider: ((state: State) => CriticalPathSampleRanges | null) | null =
  null;

export function setCriticalPathSampleRangesProvider(
  provider: (state: State) => CriticalPathSampleRanges | null
) {
  _provider = provider;
}

/**
 * The sample ranges of the path when the panels are focused on it, and null
 * when they are not (or when there is no path).
 */
export const getFocusedCriticalPathSampleRanges: Selector<
  CriticalPathSampleRanges | null
> = (state) =>
  getCriticalPathFocus(state) && _provider !== null ? _provider(state) : null;

/**
 * A copy of a thread where the samples outside of `ranges` have no stack, so
 * that they count for nothing in the call tree. `ranges` is a flat array of
 * [start, end, ...], sorted and not overlapping; a sample at the start of a
 * range is in it, one at the end is not. With no ranges, every sample is
 * dropped.
 */
export function keepSamplesInRanges(
  thread: RawThread,
  ranges: Float64Array | undefined
): RawThread {
  const { samples } = thread;
  const times = computeTimeColumnForRawSamplesTable(samples);
  const stack = samples.stack.slice();
  let rangeIndex = 0;
  for (let i = 0; i < stack.length; i++) {
    const time = times[i];
    if (ranges !== undefined) {
      // Samples are in time order, so the ranges are consumed in order too.
      while (rangeIndex < ranges.length && ranges[rangeIndex + 1] <= time) {
        rangeIndex += 2;
      }
    }
    const isInRange =
      ranges !== undefined &&
      rangeIndex < ranges.length &&
      ranges[rangeIndex] <= time;
    if (!isInRange) {
      stack[i] = null;
    }
  }
  return { ...thread, samples: { ...samples, stack } };
}
