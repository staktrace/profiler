/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { INSTANT, INTERVAL } from 'firefox-profiler/app-logic/constants';
import { StringTable } from 'firefox-profiler/utils/string-table';
import type { Profile } from 'firefox-profiler/types';
import type { MarkerSchema } from 'firefox-profiler/types/markers';
import {
  getProfileWithRawMarkers,
  type TestDefinedRawMarker,
} from './processed-profile';

export const causalMarkerSchemas: MarkerSchema[] = [
  {
    name: 'CausalTrigger',
    display: ['marker-chart', 'marker-table'],
    fields: [{ key: 'trigger', label: 'Trigger', format: 'causal-trigger-id' }],
  },
  {
    name: 'CausalEffect',
    display: ['marker-chart', 'marker-table'],
    isStackBased: true,
    fields: [{ key: 'effect', label: 'Effect', format: 'causal-effect-id' }],
  },
];

/**
 * A small profile with causal markers on three threads:
 *
 *   t-0 GeckoMain, t-1 DOM Worker, t-2 Socket Thread.
 *
 * A three-hop chain across two threads, ending in "Handle result" (t-0):
 *   t-1 "Dispatch A" @20 (outside of any causal interval)
 *     -> t-0 "Run A" [40,60], which emits "Dispatch B" @50
 *     -> t-1 "Run B" [70,90], which emits "Dispatch C" @80
 *     -> t-0 "Handle result" [100,110]
 *
 * The root of that chain, t-1 @20, is inside four ordinary (non-causal)
 * intervals on t-1: "Idle" [0,50], "Style" [5,35], "Layout" [10,30] and
 * "Paint" [15,25] (and not inside "After" [21,30]). Only the three innermost
 * are reported as the context of the root.
 *
 * A fan-in: two triggers of one id, "Request F" on t-1 @120 and on t-2 @125,
 * coalesced into "Refresh tick" on t-0 [130,140].
 *
 * An unknown cause: "Orphan task" on t-0 [150,160] has no trigger.
 *
 * The fan-in's root, t-1 @120, is not inside any marker.
 *
 * Times are in ms; the profile starts at 0 (an instant "Startup" on t-0).
 */
export function getProfileWithCausalMarkers(): Profile {
  const trigger = (
    name: string,
    time: number,
    id: string
  ): TestDefinedRawMarker => ({
    name,
    startTime: time,
    endTime: null,
    phase: INSTANT,
    data: { type: 'CausalTrigger', trigger: id } as any,
  });
  const effect = (
    name: string,
    start: number,
    end: number,
    id: string
  ): TestDefinedRawMarker => ({
    name,
    startTime: start,
    endTime: end,
    phase: INTERVAL,
    data: { type: 'CausalEffect', effect: id } as any,
  });

  const A = '00000000000000a1';
  const B = '00000000000000b2';
  const C = '00000000000000c3';
  const F = '00000000000000f4';
  const U = '00000000000000d5';

  const profile = getProfileWithRawMarkers(
    [
      { name: 'Startup', startTime: 0, endTime: null, phase: INSTANT },
      effect('Run A', 40, 60, A),
      trigger('Dispatch B', 50, B),
      effect('Handle result', 100, 110, C),
      effect('Refresh tick', 130, 140, F),
      effect('Orphan task', 150, 160, U),
    ],
    [
      { name: 'Idle', startTime: 0, endTime: 50, phase: INTERVAL },
      { name: 'Style', startTime: 5, endTime: 35, phase: INTERVAL },
      { name: 'Layout', startTime: 10, endTime: 30, phase: INTERVAL },
      { name: 'Paint', startTime: 15, endTime: 25, phase: INTERVAL },
      { name: 'After', startTime: 21, endTime: 30, phase: INTERVAL },
      trigger('Dispatch A', 20, A),
      effect('Run B', 70, 90, B),
      trigger('Dispatch C', 80, C),
      trigger('Request F', 120, F),
    ],
    [trigger('Request F', 125, F)]
  );

  // The ids are stored as indexes into the string table, like flow ids.
  const stringTable = StringTable.withBackingArray(profile.shared.stringArray);
  for (const thread of profile.threads) {
    thread.markers.data.forEach((data) => {
      if (data && 'trigger' in data) {
        data.trigger = stringTable.indexForString(data.trigger as any);
      }
      if (data && 'effect' in data) {
        data.effect = stringTable.indexForString(data.effect as any);
      }
    });
  }

  profile.meta.markerSchema = [
    ...profile.meta.markerSchema,
    ...causalMarkerSchemas,
  ];
  const names = ['GeckoMain', 'DOM Worker', 'Socket Thread'];
  profile.threads.forEach((thread, i) => {
    thread.name = names[i];
    thread.pid = '100';
    thread.isMainThread = i === 0;
  });
  return profile;
}
