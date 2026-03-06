import * as colorette from 'colorette';
import process from 'node:process';

export class ManagedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const DEFAULT_DEBUG_OBJECT_DEPTH = 4;

let debugEnabled: boolean;

/**
 * @param debugFlag Flag to enable or disable debugging
 */
export function initConsoleDebug(debugFlag: boolean) {
  debugEnabled = debugFlag;

  if (debugEnabled) {
    console.log(colorette.blue('Debug logs enabled'));
  }
}

/**
 * @param msg The debug message text
 * @param object An optional debug object to output
 * @param objectDepth The depth of the object to output, defaulting to 4
 */
export function consoleDebug(msg: string, object?: unknown, objectDepth: number = DEFAULT_DEBUG_OBJECT_DEPTH) {
  if (debugEnabled) {
    console.log(colorette.blue(`Debug: ${msg}`));
    if (object) {
      console.dir(object, { depth: objectDepth });
    }
  }
}

/**
 * @param msg The error message text
 */
export function consoleError(msg: string) {
  console.error(colorette.red(`Error: ${msg}`));
}

/**
 * Safely exits the process by waiting on any stdout buffered output before exiting.
 * @param exitCode Optional code to exit with. If not provided, defaults to 1
 */
export function safeProcessExit(exitCode = 1): never {
  consoleDebug(`Exiting process with code ${exitCode}`);

  if (process.stdout.writableNeedDrain) {
    process.stdout.once('drain', () => {
      process.exit(exitCode);
    });
  }

  process.exit(exitCode);
}
