import { renderTranscriptViewportParts } from '../src/render/components/transcript-overlay';
import { createRenderContext, serializeBlock } from '../src/render';
import { line, span } from '../src/render/primitives';
import { createTheme } from '../src/theme';
import { widthOf } from '../src/text';
import { renderCommandActivity } from '../src/render/components/tools/command-activity';
import { check, equal } from './harness';

const context = createRenderContext(createTheme(), true, 100, 40);
const largeHistory = Array.from({ length: 100_000 }, (_, index) => line(span(`history ${index}`)));
const liveTail = [line(span('live one')), line(span('live two'))];
const viewport = renderTranscriptViewportParts(
  [largeHistory, [line()], liveTail],
  0,
  context,
);
const lines = serializeBlock(viewport.block);

equal(lines.length, 40, 'large transcripts render only the physical viewport rows');
check(lines.includes('live one') && lines.includes('live two'), 'large transcript viewport includes the live tail');
check(!lines.includes('history 0'), 'large transcript viewport does not materialize off-screen history');

const longOutput = 'html '.repeat(1_000);
const commandTranscript = serializeBlock(renderCommandActivity(
  [{
    type: 'tool',
    toolCallId: 'long-output',
    toolName: 'exec_command',
    title: 'Run command',
    input: { cmd: `printf '${'x'.repeat(500)}'` },
    output: JSON.stringify({ output: longOutput, exit_code: 0 }),
    status: 'completed',
  }],
  context,
  { transcript: true },
));
check(
  commandTranscript.every(entry => widthOf(entry) <= context.width),
  'transcript commands and output are wrapped before terminal repainting',
);
check(
  commandTranscript.join('').includes(longOutput.slice(-40)),
  'wrapping transcript output preserves the complete command result',
);
