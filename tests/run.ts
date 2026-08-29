import { finish } from './harness';
import { preloadSyntaxLanguages } from '../src/render/markdown';

await preloadSyntaxLanguages();
await import('./input.test');
await import('./collaboration.test');
await import('./commands.test');
await import('./rendering.test');
await import('./cli.test');
await import('./tools.test');
await import('./titles.test');
await import('./sessions.test');
await import('./transient-terminal.test');
await import('./history-spacing.test');
await import('./transcript-performance.test');

finish();
