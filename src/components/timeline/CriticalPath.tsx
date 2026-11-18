/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as React from 'react';
import { Localized } from '@fluent/react';
import {
  BLUE_60,
  GREEN_60,
  PURPLE_50,
  TEAL_60,
  MAGENTA_60,
  YELLOW_70,
  RED_60,
  ORANGE_50,
  GREY_40,
  GREY_90,
} from 'photon-colors';

import explicitConnect from 'firefox-profiler/utils/connect';
import {
  getCommittedRange,
  getThreads,
  getZeroAt,
} from 'firefox-profiler/selectors/profile';
import {
  getCriticalPathThreadIndexes,
  getIsCriticalPathFocused,
  getTimelineCriticalPath,
  type TimelineCriticalPath as CriticalPathData,
} from 'firefox-profiler/selectors/critical-path';
import {
  changeCriticalPathFocus,
  changeCriticalPathTarget,
  selectTrackFromTid,
  updatePreviewSelection,
} from 'firefox-profiler/actions/profile-view';
import { getFriendlyThreadName } from 'firefox-profiler/profile-logic/profile-data';
import { Tooltip } from 'firefox-profiler/components/tooltip/Tooltip';
import {
  formatMilliseconds,
  formatPercent,
  formatTimestamp,
} from 'firefox-profiler/utils/format-numbers';

import type {
  CssPixels,
  Marker,
  Milliseconds,
  RawThread,
  StartEndRange,
} from 'firefox-profiler/types';
import type {
  CriticalPathRawSegment,
  CriticalPathStopReason,
} from 'firefox-profiler/profile-query/critical-path';
import type { ConnectedProps } from 'firefox-profiler/utils/connect';

import './CriticalPath.css';

export const TIMELINE_CRITICAL_PATH_HEIGHT: CssPixels = 24;

// Running segments are colored by thread, in the order of the time each thread
// contributes to the path. Threads beyond the palette share its last color.
const THREAD_COLORS = [
  BLUE_60,
  GREEN_60,
  PURPLE_50,
  TEAL_60,
  MAGENTA_60,
  YELLOW_70,
  RED_60,
];
const WAIT_BUSY_COLOR = ORANGE_50;
const WAIT_IDLE_COLOR = GREY_40;
const END_COLOR = GREY_90;

// How far from a segment the mouse can be and still hover it.
const HOVER_TOLERANCE: CssPixels = 3;

const STOP_DESCRIPTIONS: Record<CriticalPathStopReason, string> = {
  root: 'The chain starts here: nothing recorded caused this work.',
  'unknown-cause':
    'The chain stops here: this work has no recorded trigger (a dropped marker, or a source that is not instrumented).',
  'recording-start':
    'The chain reaches the start of the recorded data. Record with a larger buffer to go further back.',
  'max-depth': 'The chain was cut short at the maximum depth.',
  'profile-start': 'The chain reaches the start of the profile.',
  'non-decreasing-time':
    'The chain stops here: the next link does not go back in time.',
  'revisited-marker':
    'The chain stops here: it came back to a marker it had already visited.',
};

function isWaitBusy(segment: CriticalPathRawSegment): boolean {
  return (segment.busyMs ?? 0) > (segment.idleMs ?? 0);
}

type CanvasProps = {
  readonly rangeStart: Milliseconds;
  readonly rangeEnd: Milliseconds;
  readonly segments: ReadonlyArray<CriticalPathRawSegment>;
  readonly colorByThread: Map<number, string>;
  readonly walkEnd: Milliseconds;
  readonly width: CssPixels;
  readonly height: CssPixels;
};

class CriticalPathCanvas extends React.PureComponent<CanvasProps> {
  _canvas: HTMLCanvasElement | null = null;
  _requestedAnimationFrame: boolean = false;

  drawCanvas(canvas: HTMLCanvasElement): void {
    const {
      rangeStart,
      rangeEnd,
      segments,
      colorByThread,
      walkEnd,
      width,
      height,
    } = this.props;
    if (width === 0) {
      return;
    }
    const ctx = canvas.getContext('2d')!;
    const devicePixelRatio = window.devicePixelRatio;
    const deviceWidth = Math.round(width * devicePixelRatio);
    const deviceHeight = Math.round(height * devicePixelRatio);
    canvas.width = deviceWidth;
    canvas.height = deviceHeight;
    ctx.clearRect(0, 0, deviceWidth, deviceHeight);

    const rangeLength = rangeEnd - rangeStart;
    if (!(rangeLength > 0)) {
      return;
    }
    const xAt = (time: Milliseconds) =>
      ((time - rangeStart) / rangeLength) * deviceWidth;

    const padding = Math.round(4 * devicePixelRatio);
    const runningTop = padding;
    const runningHeight = deviceHeight - 2 * padding;
    const waitHeight = Math.max(2, Math.round(runningHeight / 3));
    const waitTop = Math.round((deviceHeight - waitHeight) / 2);

    // Waits first, so that the running segments stay visible where many short
    // segments share a pixel.
    for (const kind of ['wait', 'running'] as const) {
      for (const segment of segments) {
        if (segment.kind !== kind) {
          continue;
        }
        const x0 = xAt(segment.start);
        const x1 = xAt(segment.end);
        if (x1 < 0 || x0 > deviceWidth) {
          continue;
        }
        const left = Math.max(0, Math.floor(x0));
        const right = Math.min(deviceWidth, Math.max(left + 1, Math.ceil(x1)));
        if (kind === 'wait') {
          ctx.fillStyle = isWaitBusy(segment)
            ? WAIT_BUSY_COLOR
            : WAIT_IDLE_COLOR;
          ctx.fillRect(left, waitTop, right - left, waitHeight);
        } else {
          ctx.fillStyle =
            colorByThread.get(segment.threadIndex) ??
            THREAD_COLORS[THREAD_COLORS.length - 1];
          ctx.fillRect(left, runningTop, right - left, runningHeight);
        }
      }
    }

    // The ends of the path: where the chain starts, and the target marker.
    ctx.fillStyle = END_COLOR;
    const endWidth = Math.max(1, Math.round(devicePixelRatio));
    for (const time of [segments[0]?.start, walkEnd]) {
      if (time === undefined) {
        continue;
      }
      const x = Math.round(xAt(time));
      if (x >= 0 && x <= deviceWidth) {
        ctx.fillRect(
          Math.min(x, deviceWidth - endWidth),
          0,
          endWidth,
          deviceHeight
        );
      }
    }
  }

  _scheduleDraw() {
    if (this._requestedAnimationFrame) {
      return;
    }
    this._requestedAnimationFrame = true;
    window.requestAnimationFrame(() => {
      this._requestedAnimationFrame = false;
      if (this._canvas) {
        this.drawCanvas(this._canvas);
      }
    });
  }

  _takeCanvasRef = (canvas: HTMLCanvasElement | null) => {
    this._canvas = canvas;
  };

  override componentDidMount() {
    this._scheduleDraw();
  }

  override componentDidUpdate() {
    this._scheduleDraw();
  }

  override render() {
    return (
      <canvas
        className="timelineCriticalPathCanvas"
        ref={this._takeCanvasRef}
      />
    );
  }
}

type OwnProps = {
  readonly width: CssPixels;
};

type StateProps = {
  readonly criticalPath: CriticalPathData | null;
  readonly committedRange: StartEndRange;
  readonly zeroAt: Milliseconds;
  readonly threads: RawThread[];
  readonly isFocused: boolean;
  readonly pathThreadIndexes: Set<number>;
};

type DispatchProps = {
  readonly changeCriticalPathFocus: typeof changeCriticalPathFocus;
  readonly changeCriticalPathTarget: typeof changeCriticalPathTarget;
  readonly selectTrackFromTid: typeof selectTrackFromTid;
  readonly updatePreviewSelection: typeof updatePreviewSelection;
};

type Props = ConnectedProps<OwnProps, StateProps, DispatchProps>;

type State = {
  readonly hoveredSegment: CriticalPathRawSegment | null;
  readonly mouseX: CssPixels;
  readonly mouseY: CssPixels;
};

function markerLabel(marker: Marker | undefined): string {
  if (marker === undefined) {
    return '';
  }
  const data = marker.data as { name?: unknown } | null | undefined;
  const detail = data && typeof data.name === 'string' ? data.name : '';
  return detail ? `${marker.name} — ${detail}` : marker.name;
}

class TimelineCriticalPathImpl extends React.PureComponent<Props, State> {
  override state: State = { hoveredSegment: null, mouseX: 0, mouseY: 0 };

  _colorsFor: CriticalPathData | null = null;
  _colors: Map<number, string> = new Map();

  // Memoized, so that hovering does not redraw the canvas.
  _colorByThread(criticalPath: CriticalPathData): Map<number, string> {
    if (this._colorsFor === criticalPath) {
      return this._colors;
    }
    const colors = new Map<number, string>();
    criticalPath.walk.totalsByThread.forEach(({ threadIndex }, rank) => {
      colors.set(
        threadIndex,
        THREAD_COLORS[Math.min(rank, THREAD_COLORS.length - 1)]
      );
    });
    this._colorsFor = criticalPath;
    this._colors = colors;
    return colors;
  }

  _threadName(threadIndex: number): string {
    const { threads } = this.props;
    const thread = threads[threadIndex];
    return thread ? getFriendlyThreadName(threads, thread) : '';
  }

  _segmentAtEvent(
    event: React.MouseEvent<HTMLElement>
  ): CriticalPathRawSegment | null {
    const { criticalPath, committedRange } = this.props;
    if (criticalPath === null) {
      return null;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) {
      return null;
    }
    const msPerPixel = (committedRange.end - committedRange.start) / rect.width;
    const time = committedRange.start + (event.pageX - rect.left) * msPerPixel;
    const tolerance = HOVER_TOLERANCE * msPerPixel;

    // Prefer the segment containing the time, and a running segment over a
    // wait. Otherwise take the closest one within the tolerance.
    let best: CriticalPathRawSegment | null = null;
    let bestDistance = Infinity;
    for (const segment of criticalPath.walk.segments) {
      if (segment.start > time + tolerance) {
        break;
      }
      let distance = 0;
      if (time < segment.start) {
        distance = segment.start - time;
      } else if (time > segment.end) {
        distance = time - segment.end;
      }
      if (distance > tolerance) {
        continue;
      }
      if (
        distance < bestDistance ||
        (distance === bestDistance && segment.kind === 'running')
      ) {
        best = segment;
        bestDistance = distance;
      }
    }
    return best;
  }

  _onMouseMove = (event: React.MouseEvent<HTMLElement>) => {
    this.setState({
      hoveredSegment: this._segmentAtEvent(event),
      mouseX: event.pageX,
      mouseY: event.pageY,
    });
  };

  _onMouseLeave = () => {
    this.setState({ hoveredSegment: null });
  };

  // Keep the timeline from starting a range selection here: a click selects
  // the segment instead.
  _onMouseDown = (event: React.MouseEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  _onClick = (event: React.MouseEvent<HTMLElement>) => {
    const segment = this._segmentAtEvent(event);
    if (segment === null) {
      return;
    }
    const { threads, selectTrackFromTid, updatePreviewSelection } = this.props;
    const thread = threads[segment.threadIndex];
    if (thread) {
      selectTrackFromTid(thread.tid);
    }
    if (segment.end > segment.start) {
      updatePreviewSelection({
        isModifying: false,
        selectionStart: segment.start,
        selectionEnd: segment.end,
      });
    }
  };

  _close = () => {
    this.props.changeCriticalPathTarget(null);
  };

  // Show the path as one synthetic thread in the panels: select the threads
  // that ran on it, and keep only the samples taken while they did.
  _toggleFocus = () => {
    const { isFocused, pathThreadIndexes, changeCriticalPathFocus } =
      this.props;
    changeCriticalPathFocus(!isFocused, pathThreadIndexes);
  };

  _renderTooltip(
    criticalPath: CriticalPathData,
    segment: CriticalPathRawSegment
  ) {
    const { zeroAt } = this.props;
    const { markerLists, walk } = criticalPath;
    const markerOf = (ref: { threadIndex: number; markerIndex: number }) =>
      markerLabel(markerLists[ref.threadIndex]?.[ref.markerIndex]);
    const thread = this._threadName(segment.threadIndex);
    const duration = segment.end - segment.start;
    const lines: Array<[string, string]> = [];
    let title;

    switch (segment.kind) {
      case 'running':
        title = `Running on ${thread}`;
        lines.push(['Duration', formatMilliseconds(duration)]);
        if (segment.entryMarker) {
          lines.push(['In', markerOf(segment.entryMarker)]);
        }
        if (segment.blocking) {
          lines.push([
            'On the path because',
            'it ran while a later step of the path was waiting for this thread',
          ]);
        }
        if (segment.nestedUnknownCause) {
          lines.push(['Note', 'No recorded trigger; ran synchronously']);
        }
        break;
      case 'wait': {
        const source = this._threadName(segment.sourceThreadIndex ?? -1);
        title =
          source === thread
            ? `Waiting on ${thread}`
            : `Waiting: ${source} → ${thread}`;
        lines.push(['Duration', formatMilliseconds(duration)]);
        lines.push([
          'Queued behind other work',
          formatMilliseconds(segment.busyMs ?? 0),
        ]);
        lines.push(['Idle', formatMilliseconds(segment.idleMs ?? 0)]);
        if (segment.triggerMarker) {
          lines.push(['Trigger', markerOf(segment.triggerMarker)]);
        }
        if (segment.effectMarker) {
          lines.push(['Effect', markerOf(segment.effectMarker)]);
        }
        if (segment.alternateCauseCount) {
          lines.push(['Other triggers', String(segment.alternateCauseCount)]);
        }
        break;
      }
      case 'root':
      case 'unknown-cause':
        title = `Start of the path on ${thread}`;
        if (segment.entryMarker) {
          lines.push(['In', markerOf(segment.entryMarker)]);
        }
        break;
      default:
        title = '';
    }
    // The oldest segment says why the path does not go further back. A
    // zero-length start is hard to hover, so the segment after it says so too.
    const [first, second] = walk.segments;
    if (
      segment === first ||
      (segment === second && first.end === first.start)
    ) {
      lines.push(['Start of the path', STOP_DESCRIPTIONS[walk.stopReason]]);
    }
    lines.push([
      'Time',
      duration > 0
        ? `${formatTimestamp(segment.start - zeroAt)} – ${formatTimestamp(segment.end - zeroAt)}`
        : formatTimestamp(segment.start - zeroAt),
    ]);

    return (
      <div className="timelineCriticalPathTooltip">
        <div className="tooltipOneLine tooltipHeader">
          <div className="tooltipTitle">{title}</div>
        </div>
        <div className="tooltipDetails">
          {lines.map(([label, value], i) => (
            <React.Fragment key={i}>
              <div className="tooltipLabel">{label}:</div>
              <div>{value}</div>
            </React.Fragment>
          ))}
        </div>
      </div>
    );
  }

  _summary(criticalPath: CriticalPathData): string {
    const { walk, hasCausalSchema } = criticalPath;
    if (!hasCausalSchema) {
      return 'This profile was recorded without causal markers, so there are no links to follow.';
    }
    const { running, waitBusy, waitIdle } = walk.totalsByKind;
    const total = running + waitBusy + waitIdle;
    if (!(total > 0)) {
      return STOP_DESCRIPTIONS[walk.stopReason];
    }
    return (
      `${formatMilliseconds(total)}: ` +
      `${formatPercent(running / total)} running, ` +
      `${formatPercent(waitBusy / total)} queued behind other work, ` +
      `${formatPercent(waitIdle / total)} idle. ` +
      STOP_DESCRIPTIONS[walk.stopReason]
    );
  }

  override render() {
    const { criticalPath, committedRange, width, isFocused } = this.props;
    if (criticalPath === null) {
      return null;
    }
    const { hoveredSegment, mouseX, mouseY } = this.state;
    const { walk, targetMarker } = criticalPath;
    const lastSegment = walk.segments[walk.segments.length - 1];
    const targetLabel = markerLabel(targetMarker);

    return (
      <div
        className="timelineCriticalPath"
        style={{ height: TIMELINE_CRITICAL_PATH_HEIGHT }}
      >
        <div
          className="timelineCriticalPathLabel"
          title={`${targetLabel}\n${this._summary(criticalPath)}`}
        >
          <span className="timelineCriticalPathLabelText">
            <Localized id="TimelineCriticalPath--label">
              <span className="timelineCriticalPathLabelTitle">
                Critical path
              </span>
            </Localized>{' '}
            {targetLabel}
          </span>
          <Localized
            id="TimelineCriticalPath--focus-button"
            attrs={{ title: true }}
          >
            <button
              type="button"
              className={
                'timelineCriticalPathFocus' + (isFocused ? ' checked' : '')
              }
              aria-pressed={isFocused}
              title="Show the path as one thread: select the threads that ran on it and keep only the samples taken while they did"
              onClick={this._toggleFocus}
            >
              Focus
            </button>
          </Localized>
          <Localized
            id="TimelineCriticalPath--close-button"
            attrs={{ title: true }}
          >
            <button
              type="button"
              className="timelineCriticalPathClose"
              title="Hide the critical path"
              onClick={this._close}
            />
          </Localized>
        </div>
        <div
          className="timelineCriticalPathGraph"
          style={{ width }}
          onMouseMove={this._onMouseMove}
          onMouseLeave={this._onMouseLeave}
          onMouseDown={this._onMouseDown}
          onClick={this._onClick}
        >
          <CriticalPathCanvas
            rangeStart={committedRange.start}
            rangeEnd={committedRange.end}
            segments={walk.segments}
            colorByThread={this._colorByThread(criticalPath)}
            walkEnd={lastSegment ? lastSegment.end : targetMarker.start}
            width={width}
            height={TIMELINE_CRITICAL_PATH_HEIGHT}
          />
          {hoveredSegment === null ? null : (
            <Tooltip mouseX={mouseX} mouseY={mouseY}>
              {this._renderTooltip(criticalPath, hoveredSegment)}
            </Tooltip>
          )}
        </div>
      </div>
    );
  }
}

export const TimelineCriticalPath = explicitConnect<
  OwnProps,
  StateProps,
  DispatchProps
>({
  mapStateToProps: (state) => ({
    criticalPath: getTimelineCriticalPath(state),
    isFocused: getIsCriticalPathFocused(state),
    pathThreadIndexes: getCriticalPathThreadIndexes(state),
    committedRange: getCommittedRange(state),
    zeroAt: getZeroAt(state),
    threads: getThreads(state),
  }),
  mapDispatchToProps: {
    changeCriticalPathFocus,
    changeCriticalPathTarget,
    selectTrackFromTid,
    updatePreviewSelection,
  },
  component: TimelineCriticalPathImpl,
});
