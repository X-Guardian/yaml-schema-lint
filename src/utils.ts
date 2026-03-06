/** https://nodejs.org/api/process.html */
import process from 'node:process';
/** https://www.npmjs.com/package/colorette */
import * as colorette from 'colorette';

/**
 * Custom error class for managed errors.
 * @param message The error message
 */
export class ManagedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Default depth for console.dir output of debug objects. */
const DEFAULT_DEBUG_OBJECT_DEPTH = 4;

/** Flag to enable or disable debugging. */
let debugEnabled: boolean;

/**
 * Initialize the console debug flag.
 * @param debugFlag Flag to enable or disable debugging
 */
export function initConsoleDebug(debugFlag: boolean) {
  debugEnabled = debugFlag;

  if (debugEnabled) {
    console.log(colorette.blue('Debug logs enabled'));
  }
}

/**
 * Output a debug message to the console.
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
 * Output an error message to the console.
 * @param msg The error message text
 */
export function consoleError(msg: string) {
  console.error(colorette.red(`Error: ${msg}`));
}

/**
 * Safely exits the process by waiting on any stdout buffered output before exiting.
 * @param exitCode The exit code to use. Defaults to 1 if not provided.
 */
export function safeProcessExit(exitCode = 1): never {
  consoleDebug(`Exiting process with code ${String(exitCode)}`);

  if (process.stdout.writableNeedDrain) {
    process.stdout.once('drain', () => {
      process.exit(exitCode);
    });
  }

  process.exit(exitCode);
}
