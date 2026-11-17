/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as fs from 'fs';
import { serializeProfileToJsonString } from 'firefox-profiler/profile-logic/process-profile';
import { ProfileQuerier } from 'firefox-profiler/profile-query';
import { getProfileRootRange } from 'firefox-profiler/selectors/profile';
import { storeWithProfile } from '../../../../src/test/fixtures/stores';
import { getProfileWithCausalMarkers } from '../../../../src/test/fixtures/profiles/causal-markers';
import { getProfileWithMarkers } from '../../../../src/test/fixtures/profiles/processed-profile';
import {
  formatMarkerCauseResult,
  formatMarkerCriticalPathResult,
} from '../../formatters';
import type { Profile } from 'firefox-profiler/types';

function makeQuerier(profile: Profile) {
  const store = storeWithProfile(profile);
  return new ProfileQuerier(store, getProfileRootRange(store.getState()));
}

async function handleFor(
  querier: ProfileQuerier,
  thread: string,
  name: string
): Promise<string> {
  const result = await querier.threadMarkers(thread, { list: true });
  return result.flatMarkers!.find((m) => m.name === name)!.handle;
}

describe('causal marker formatting', function () {
  it('uses a CLI fixture that matches the fixture generator', function () {
    // profiler-cli/src/test/fixtures/causal-chain.json is the serialization of
    // getProfileWithCausalMarkers(). To regenerate it, write
    // JSON.stringify(JSON.parse(serializeProfileToJsonString(profile)), null, 1)
    // to that file.
    const onDisk = JSON.parse(
      fs.readFileSync(
        'profiler-cli/src/test/fixtures/causal-chain.json',
        'utf-8'
      )
    );
    const generated = JSON.parse(
      serializeProfileToJsonString(getProfileWithCausalMarkers())
    );
    expect(onDisk).toEqual(generated);
  });

  it('formats the critical path of a three-hop chain', async function () {
    const querier = makeQuerier(getProfileWithCausalMarkers());
    const handle = await handleFor(querier, 't-0', 'Handle result');
    const text = formatMarkerCriticalPathResult(
      await querier.markerCriticalPath(handle)
    );

    expect(text).toContain(`Critical path to marker ${handle}: Handle result`);
    expect(text).toContain('Path length 90ms');
    expect(text).not.toContain('unattributed');
    // Every segment is numbered and has a range usable with `zoom push`.
    const segmentLines = text
      .split('\n')
      .filter((line) => /^ {2}\[\d+\] /.test(line));
    expect(segmentLines.map((l) => l.match(/\[\d+\] (\S+)/)![1])).toEqual([
      'root',
      'wait',
      'running',
      'wait',
      'running',
      'wait',
      'running',
    ]);
    for (const line of segmentLines.filter((l) => !/\[1\] root/.test(l))) {
      expect(line).toMatch(/zoom push ts[-<>]\w+,ts[-<>]\w+/);
    }
    expect(text).toContain('trigger m-');
    expect(text).toContain('"Dispatch C" on t-1');
    expect(text).toContain('By thread:');
    expect(text).toMatch(/\[1\] root +t-1 \(DOM Worker\) {2}at 0\.0200s/);
    expect(text).toMatch(
      /chain starts inside: m-\d+ "Paint" \(0\.0150s - 0\.0250s\), m-\d+ "Layout" \(0\.0100s - 0\.0300s\), m-\d+ "Style" \(0\.0050s - 0\.0350s\)\n/
    );
    expect(text).toContain(
      'Stopped: the chain starts here: no causal effect marker covers this point'
    );
  });

  it('says so when the root has no enclosing marker', async function () {
    const querier = makeQuerier(getProfileWithCausalMarkers());
    const text = formatMarkerCriticalPathResult(
      await querier.markerCriticalPath(
        await handleFor(querier, 't-0', 'Refresh tick')
      )
    );
    expect(text).toMatch(/\[1\] root +t-1 \(DOM Worker\)/);
    expect(text).toContain('no enclosing marker');
    expect(text).not.toContain('chain starts inside');
  });

  it('shows alternate causes and unknown causes', async function () {
    const querier = makeQuerier(getProfileWithCausalMarkers());
    const tick = formatMarkerCriticalPathResult(
      await querier.markerCriticalPath(
        await handleFor(querier, 't-0', 'Refresh tick')
      )
    );
    expect(tick).toContain('1 alternate cause not followed');

    const orphan = formatMarkerCriticalPathResult(
      await querier.markerCriticalPath(
        await handleFor(querier, 't-0', 'Orphan task')
      )
    );
    expect(orphan).toContain('has no known trigger');
    expect(orphan).toContain('Stopped: the effect at the start of the chain');
  });

  it('warns when the profile was recorded without causal markers', async function () {
    const querier = makeQuerier(
      getProfileWithMarkers([
        ['Alpha', 10, null, { type: 'tracing', category: 'Test' }],
      ])
    );
    const handle = await handleFor(querier, 't-0', 'Alpha');
    const text = formatMarkerCriticalPathResult(
      await querier.markerCriticalPath(handle)
    );
    expect(text).toContain('Warning: This profile has no marker schema');
    expect(text).toContain('without causal markers');

    const cause = formatMarkerCauseResult(await querier.markerCause(handle));
    expect(cause).toContain('recorded without causal markers');
  });

  it('formats marker cause for a trigger and an effect', async function () {
    const querier = makeQuerier(getProfileWithCausalMarkers());
    const effect = await querier.markerCause(
      await handleFor(querier, 't-0', 'Refresh tick')
    );
    const effectText = formatMarkerCauseResult(effect);
    expect(effectText).toContain('Effect (field effect, id 00000000000000f4)');
    expect(effectText).toContain('Caused by: m-');
    expect(effectText).toContain('Also caused by (alternate): m-');

    const triggerHandle = (effect.occurrences[0].causes as any).primary.marker
      .markerHandle;
    const triggerText = formatMarkerCauseResult(
      await querier.markerCause(triggerHandle)
    );
    expect(triggerText).toContain('Trigger (field trigger');
    expect(triggerText).toContain('Primary cause of:');
    expect(triggerText).toContain('Refresh tick');
  });
});
