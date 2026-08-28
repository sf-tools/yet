import {
  clampTransientLines,
  clearTransientSequence,
  patchTransientSequence,
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
equal(clear, '\u001b[49F\u001b[0J', 'transient clear erases the viewport in one bounded sequence');
check(!clear.includes('\u001b[E'), 'transient clear never advances rows while erasing');
equal(clearTransientSequence(1), '\r\u001b[0J', 'single-line transient clear stays on its row');
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
