import {
  clampTransientLines,
  clearTransientSequence,
  diffScreenRowsSequence,
  patchTransientSequence,
  reconcileTransientSequence,
  replaceTransientSequence,
  synchronizedTerminalSequence,
  takeBlockTail,
} from '../src/agent/transient-terminal';
import { check, deepEqual, equal } from './harness';

const oversized = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
const visible = clampTransientLines(oversized, 20);
equal(visible.length, 19, 'transient output reserves one viewport row');
equal(visible[0], 'line 82', 'transient output keeps the newest visible rows');
equal(visible.at(-1), 'line 100', 'transient output keeps its final row');
deepEqual(clampTransientLines(oversized, 1), ['line 100'], 'one-row terminals retain the final transient row');

const tail = takeBlockTail([['one', 'two'], ['three'], ['four', 'five']], 3);
deepEqual(tail, ['three', 'four', 'five'], 'block tail is bounded before serialization');
deepEqual(takeBlockTail([['one'], ['two']], 0), [], 'zero-sized block tail is empty');

const clear = clearTransientSequence(50);
equal(clear, '\u001b[49F\u001b[50M', 'transient clear deletes only its owned rows');
check(!clear.includes('\u001b[E'), 'transient clear never advances rows while erasing');
check(!clear.includes('\u001b[0J'), 'transient clear never erases the complete remaining viewport');
equal(clearTransientSequence(1), '\r\u001b[1M', 'single-line transient clear deletes only its row');
equal(
  synchronizedTerminalSequence('frame'),
  '\u001b[?2026hframe\u001b[?2026l',
  'transient repaints use the synchronized-update protocol',
);
equal(synchronizedTerminalSequence(''), '', 'empty synchronized repaints write nothing');

const patch = patchTransientSequence(['a', 'b', 'c'], ['a', 'B', 'c']);
equal(patch, '\u001b[1F\u001b[2K\rB\u001b[1E\r', 'transient patch updates changed rows in one sequence');
equal(patchTransientSequence(['a'], ['a']), '', 'unchanged transient rows produce no terminal output');
equal(patchTransientSequence(['a'], ['a', 'b']), null, 'different transient heights require a redraw');

const grown = reconcileTransientSequence(['one', 'two'], ['one', 'TWO', 'three']);
check(grown.startsWith('\r\n'), 'growing transient output allocates only the added rows');
check(!grown.includes('\u001b[0J'), 'growing transient output never clears the viewport');
check(grown.includes('TWO') && grown.includes('three'), 'growing transient output patches changed and added rows');

const shrunk = reconcileTransientSequence(['one', 'two', 'three'], ['one', 'TWO']);
check(shrunk.startsWith('\u001b[1F'), 'shrinking transient output first returns to its new final row');
check(shrunk.includes('TWO'), 'shrinking transient output patches retained rows');
check(shrunk.endsWith('\u001b[1B\u001b[0J\u001b[1A\r'), 'shrinking clears only rows below its new endpoint');

equal(
  reconcileTransientSequence(['one', 'two'], []),
  '\u001b[1F\u001b[2M',
  'removing transient output deletes its owned rows without a viewport erase',
);

equal(
  replaceTransientSequence(['old panel', 'old footer'], ['loading panel', 'loading footer', 'new row']),
  '\u001b[1F\u001b[2Mloading panel\r\nloading footer\r\nnew row',
  'replacing a composer surface atomically deletes its old rows before repainting',
);
check(
  !replaceTransientSequence(['old'], ['new', 'row']).startsWith('\r\n'),
  'composer surface replacement never uses the incremental growth path',
);
check(
  replaceTransientSequence(['old'], ['first', 'second']).includes('first\r\nsecond'),
  'composer surface replacement returns to column zero for every raw-terminal row',
);

equal(
  diffScreenRowsSequence([], ['header', 'body']),
  '\u001b[2J\u001b[Hheader\nbody',
  'the first transcript frame initializes the alternate screen once',
);
equal(
  diffScreenRowsSequence(['header', 'body'], ['header', 'BODY']),
  '\u001b[2;1H\u001b[2KBODY\u001b[2;1H',
  'later transcript frames repaint only changed rows',
);
equal(
  diffScreenRowsSequence(['header', 'body'], ['header', 'body']),
  '',
  'unchanged transcript frames produce no terminal output',
);

const scrolled = diffScreenRowsSequence(
  ['header', 'one', 'two', 'three', '50%', 'help', 'quit'],
  ['header', 'two', 'three', 'four', '60%', 'help', 'quit'],
  {
    scrollRegion: { startRow: 1, endRow: 3 },
    terminalWidth: 80,
  },
);
check(scrolled.includes('\u001b[2;4r\u001b[1S\u001b[r'), 'transcript scrolling uses a bounded terminal scroll region');
check(scrolled.includes('\u001b[4;1H\u001b[2Kfour'), 'transcript scrolling paints only the newly exposed row');
check(scrolled.includes('\u001b[5;1H\u001b[2K60%'), 'transcript scrolling still patches changed chrome');

const unsafeScroll = diffScreenRowsSequence(
  ['header', 'one line that physically wraps', 'two', 'footer'],
  ['header', 'two', 'three', 'footer'],
  {
    scrollRegion: { startRow: 1, endRow: 2 },
    terminalWidth: 10,
  },
);
check(!unsafeScroll.includes('\u001b[2;3r'), 'wrapped transcript rows disable the scroll-region shortcut');
check(unsafeScroll.includes('\u001b[2;1H'), 'unsafe scroll frames fall back to bounded row patches');
