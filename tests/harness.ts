function fail(error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
}

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

let assertions = 0;

export function check(condition: unknown, message: string, detail?: string): asserts condition {
  assertions += 1;
  if (!condition) throw new Error(`assertion failed: ${message}${detail ? `: ${detail}` : ''}`);
  process.stdout.write(`ok ${assertions} - ${message}\n`);
}

export function equal(actual: unknown, expected: unknown, message = 'values are equal') {
  check(Object.is(actual, expected), message, `${String(actual)} !== ${String(expected)}`);
}

export function deepEqual(actual: unknown, expected: unknown, message = 'values are deeply equal') {
  check(JSON.stringify(actual) === JSON.stringify(expected), message);
}

export async function rejects(operation: Promise<unknown>, pattern: RegExp, message: string) {
  try {
    await operation;
  } catch (error) {
    check(pattern.test(error instanceof Error ? error.message : String(error)), message);
    return;
  }
  throw new Error('assertion failed: expected operation to reject');
}

export function finish() {
  process.stdout.write(`1..${assertions}\n`);
}
