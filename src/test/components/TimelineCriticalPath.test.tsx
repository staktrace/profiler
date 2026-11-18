/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { Provider } from 'react-redux';
import { fireEvent, screen } from '@testing-library/react';

import { render } from 'firefox-profiler/test/fixtures/testing-library';
import { TimelineCriticalPath } from '../../components/timeline/CriticalPath';
import {
  changeCriticalPathFocus,
  changeCriticalPathTarget,
} from '../../actions/profile-view';
import { getThreadsKey } from '../../profile-logic/profile-data';
import {
  getCommittedRange,
  getPreviewSelection,
} from '../../selectors/profile';
import {
  getCriticalPathFocus,
  getCriticalPathTarget,
  getSelectedThreadIndexes,
} from '../../selectors/url-state';
import {
  getThreadSelectors,
  getThreadSelectorsFromThreadsKey,
} from '../../selectors/per-thread';
import {
  getIsCriticalPathFocused,
  getTimelineCriticalPath,
} from '../../selectors/critical-path';
import { ensureExists } from '../../utils/types';

import {
  autoMockCanvasContext,
  flushDrawLog,
} from '../fixtures/mocks/canvas-context';
import { mockRaf } from '../fixtures/mocks/request-animation-frame';
import { storeWithProfile } from '../fixtures/stores';
import {
  addRootOverlayElement,
  removeRootOverlayElement,
  getMouseEvent,
} from '../fixtures/utils';
import {
  causalMarkerSchemas,
  getProfileWithCausalMarkers,
} from '../fixtures/profiles/causal-markers';
import {
  addRawMarkersToThread,
  getProfileFromTextSamples,
} from '../fixtures/profiles/processed-profile';
import { StringTable } from '../../utils/string-table';
import { INSTANT, INTERVAL } from '../../app-logic/constants';
import { autoMockElementSize } from '../fixtures/mocks/element-size';

const GRAPH_WIDTH = 400;
const GRAPH_HEIGHT = 24;

// See the fixture: a three-hop chain across t-0 and t-1 ends in "Handle
// result" on t-0, and "Orphan task" on t-0 has no trigger.
describe('TimelineCriticalPath', function () {
  function setup(targetName: string | null = 'Handle result') {
    const store = storeWithProfile(getProfileWithCausalMarkers());
    const { getState, dispatch } = store;
    const flushRafCalls = mockRaf();

    if (targetName !== null) {
      const markers = getThreadSelectors(0).getFullMarkerList(getState());
      dispatch(
        changeCriticalPathTarget({
          threadIndex: 0,
          markerIndex: markers.findIndex((m) => m.name === targetName),
        })
      );
    }

    const renderResult = render(
      <Provider store={store}>
        <TimelineCriticalPath width={GRAPH_WIDTH} />
      </Provider>
    );
    flushRafCalls();

    const { container } = renderResult;
    const getGraph = () =>
      ensureExists(
        container.querySelector('.timelineCriticalPathGraph'),
        `Couldn't find the critical path graph`
      );
    const pixelAt = (time: number) => {
      const { start, end } = getCommittedRange(getState());
      return ((time - start) / (end - start)) * GRAPH_WIDTH;
    };
    const mouseAt = (type: string, time: number) =>
      fireEvent(getGraph(), getMouseEvent(type, { pageX: pixelAt(time) }));
    const getTooltip = () =>
      document.querySelector('.timelineCriticalPathTooltip');

    return { ...renderResult, getState, dispatch, mouseAt, getTooltip };
  }

  autoMockCanvasContext();
  autoMockElementSize({ width: GRAPH_WIDTH, height: GRAPH_HEIGHT });
  beforeEach(addRootOverlayElement);
  afterEach(removeRootOverlayElement);

  it('renders nothing without a target', () => {
    const { container, getState } = setup(null);
    expect(getTimelineCriticalPath(getState())).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it('computes the path to the target marker', () => {
    const { getState } = setup();
    const { walk } = ensureExists(getTimelineCriticalPath(getState()));
    expect(walk.stopReason).toBe('root');
    expect(walk.segments.map((s) => [s.kind, s.threadIndex])).toEqual([
      ['root', 1],
      ['wait', 0],
      ['running', 0],
      ['wait', 1],
      ['running', 1],
      ['wait', 0],
      ['running', 0],
    ]);
  });

  it('shows the target marker and draws the segments', () => {
    setup();
    expect(screen.getByText('Critical path')).toBeInTheDocument();
    expect(screen.getByText(/Handle result/)).toBeInTheDocument();
    const fills = flushDrawLog().filter(([name]) => name === 'fillRect');
    // Three waits, three running segments, and the two ends of the path.
    expect(fills).toHaveLength(8);
  });

  it('shows a tooltip for the hovered segment', () => {
    const { mouseAt, getTooltip, container } = setup();
    expect(getTooltip()).toBeFalsy();

    // Thread 1 runs "Run B" in [70, 90].
    mouseAt('mousemove', 75);
    expect(ensureExists(getTooltip())).toHaveTextContent(/Running on/);
    expect(ensureExists(getTooltip())).toHaveTextContent(/Run B/);

    // The wait for "Handle result", triggered by "Dispatch C" at 80.
    mouseAt('mousemove', 95);
    expect(ensureExists(getTooltip())).toHaveTextContent(/Waiting/);
    expect(ensureExists(getTooltip())).toHaveTextContent(/Dispatch C/);

    fireEvent.mouseLeave(
      ensureExists(container.querySelector('.timelineCriticalPathGraph'))
    );
    expect(getTooltip()).toBeFalsy();
  });

  it('selects the thread and time range of a clicked segment', () => {
    const { mouseAt, getState } = setup();
    mouseAt('click', 75);
    expect([...getSelectedThreadIndexes(getState())]).toEqual([1]);
    expect(getPreviewSelection(getState())).toMatchObject({
      selectionStart: 70,
      selectionEnd: 80,
    });
  });

  it('says why the chain stops for a marker with no trigger', () => {
    const { mouseAt, getTooltip, getState } = setup('Orphan task');
    const { walk } = ensureExists(getTimelineCriticalPath(getState()));
    expect(walk.stopReason).toBe('unknown-cause');
    mouseAt('mousemove', 150);
    expect(ensureExists(getTooltip())).toHaveTextContent(/no recorded trigger/);
  });

  it('focuses the panels on the path, and ends the focus when closed', () => {
    const { getState } = setup();
    expect(getIsCriticalPathFocused(getState())).toBe(false);

    fireEvent.click(screen.getByText('Focus'));
    expect(getIsCriticalPathFocused(getState())).toBe(true);
    // The threads that ran on the path are selected together.
    expect([...getSelectedThreadIndexes(getState())].sort()).toEqual([0, 1]);

    fireEvent.click(screen.getByText('Focus'));
    expect(getIsCriticalPathFocused(getState())).toBe(false);
    expect([...getSelectedThreadIndexes(getState())].sort()).toEqual([0, 1]);

    fireEvent.click(screen.getByText('Focus'));
    fireEvent.click(screen.getByTitle('Hide the critical path'));
    expect(getCriticalPathFocus(getState())).toBe(false);
  });

  it('keeps only the samples taken while a thread ran on the path', () => {
    // Two threads with a sample every millisecond from 0 to 11, and a path:
    //   thread 1 triggers X at 1 -> thread 0 runs E1 in [3, 6], which triggers
    //   Y at 4 -> thread 1 runs E2 in [7, 9].
    const row = Array(12).fill('A').join('  ');
    const { profile } = getProfileFromTextSamples(row, row);
    const stringTable = StringTable.withBackingArray(
      profile.shared.stringArray
    );
    const id = (name: string) => stringTable.indexForString(name);
    const trigger = (name: string, time: number, flow: string) => ({
      name,
      startTime: time,
      endTime: null,
      phase: INSTANT,
      data: { type: 'CausalTrigger', trigger: id(flow) } as any,
    });
    const effect = (
      name: string,
      start: number,
      end: number,
      flow: string
    ) => ({
      name,
      startTime: start,
      endTime: end,
      phase: INTERVAL,
      data: { type: 'CausalEffect', effect: id(flow) } as any,
    });
    addRawMarkersToThread(profile.threads[0], profile.shared, [
      effect('E1', 3, 6, 'x'),
      trigger('Trigger Y', 4, 'y'),
    ]);
    addRawMarkersToThread(profile.threads[1], profile.shared, [
      trigger('Trigger X', 1, 'x'),
      effect('E2', 7, 9, 'y'),
    ]);
    profile.meta.markerSchema = [
      ...profile.meta.markerSchema,
      ...causalMarkerSchemas,
    ];

    const { getState, dispatch } = storeWithProfile(profile);
    const keptTimes = (threadIndexes: number[]) => {
      const { samples } = getThreadSelectorsFromThreadsKey(
        getThreadsKey(new Set(threadIndexes))
      ).getRangeFilteredThread(getState());
      const times = [];
      for (let i = 0; i < samples.length; i++) {
        if (samples.stack[i] !== null) {
          times.push(samples.time[i]);
        }
      }
      return times;
    };
    expect(keptTimes([0])).toHaveLength(12);

    const markers = getThreadSelectors(1).getFullMarkerList(getState());
    dispatch(
      changeCriticalPathTarget({
        threadIndex: 1,
        markerIndex: markers.findIndex((m) => m.name === 'E2'),
      })
    );
    // Showing the path changes nothing by itself.
    expect(keptTimes([0])).toHaveLength(12);

    dispatch(changeCriticalPathFocus(true));
    // Thread 0 ran on the path from the start of E1 to the trigger of E2, and
    // thread 1 for all of E2.
    expect(keptTimes([0])).toEqual([3]);
    expect(keptTimes([1])).toEqual([7, 8]);
    // Merged, the two threads make up the path as one thread.
    expect(keptTimes([0, 1])).toEqual([3, 7, 8]);
    // The markers are untouched.
    expect(getThreadSelectors(1).getFullMarkerList(getState())).toHaveLength(
      markers.length
    );

    dispatch(changeCriticalPathFocus(false));
    expect(keptTimes([1])).toHaveLength(12);
  });

  it('can be closed', () => {
    const { container, getState } = setup();
    fireEvent.click(screen.getByTitle('Hide the critical path'));
    expect(getCriticalPathTarget(getState())).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });
});
