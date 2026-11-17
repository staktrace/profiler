/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { Provider } from 'react-redux';
import { fireEvent, screen } from '@testing-library/react';

import { render } from 'firefox-profiler/test/fixtures/testing-library';
import { TimelineCriticalPath } from '../../components/timeline/CriticalPath';
import { changeCriticalPathTarget } from '../../actions/profile-view';
import {
  getCommittedRange,
  getPreviewSelection,
} from '../../selectors/profile';
import {
  getCriticalPathTarget,
  getSelectedThreadIndexes,
} from '../../selectors/url-state';
import { getThreadSelectors } from '../../selectors/per-thread';
import { getTimelineCriticalPath } from '../../selectors/critical-path';
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
import { getProfileWithCausalMarkers } from '../fixtures/profiles/causal-markers';
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

  it('can be closed', () => {
    const { container, getState } = setup();
    fireEvent.click(screen.getByTitle('Hide the critical path'));
    expect(getCriticalPathTarget(getState())).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });
});
