/** A CLI flag–value pair used to build Commander argument arrays in tests. */
export interface CommandOption {
  flag: string;
  value: string;
}

/**
 * Fluent builder for constructing Commander CLI argument arrays in tests.
 * @example
 * const args = createCommandOptions('')
 *   .addOption('--debug', 'false')
 *   .addOption('--cache-ttl', '3600')
 *   .build();
 * // ['--debug', 'false', '--cache-ttl', '3600']
 */
export class CommandOptionsBuilder {
  private options: CommandOption[] = [];
  private commandName: string;

  /** @param commandName The command name to prefix the argument array with */
  constructor(commandName: string) {
    this.commandName = commandName;
  }

  /**
   * Append a flag–value pair.
   * @param flag The CLI flag (e.g. `'--debug'`)
   * @param value The flag's value
   * @returns This builder for chaining
   */
  addOption(flag: string, value: string): this {
    this.options.push({ flag, value });
    return this;
  }

  /**
   * Remove previously added options by flag name.
   * @param flagsToOmit Flags to remove from the builder
   * @returns This builder for chaining
   */
  omitOptions(flagsToOmit: string[]): this {
    this.options = this.options.filter((option) => !flagsToOmit.includes(option.flag));
    return this;
  }

  /**
   * Produce the final string array suitable for `command.parseAsync(args, { from: 'user' })`.
   * @returns The assembled argument array
   */
  build(): string[] {
    const args: string[] = [];
    if (this.commandName) {
      args.push(this.commandName);
    }
    for (const option of this.options) {
      args.push(option.flag, option.value);
    }
    return args;
  }

  /**
   * Create a shallow copy so a base set of options can be reused across tests.
   * @returns A new builder with the same options
   */
  clone(): CommandOptionsBuilder {
    const cloned = new CommandOptionsBuilder(this.commandName);
    cloned.options = [...this.options];
    return cloned;
  }
}

/**
 * Create a new {@link CommandOptionsBuilder} for assembling CLI argument arrays in tests.
 * @param commandName The command name to prefix args with (use `''` for no prefix)
 * @returns A new CommandOptionsBuilder
 */
export function createCommandOptions(commandName: string): CommandOptionsBuilder {
  return new CommandOptionsBuilder(commandName);
}
