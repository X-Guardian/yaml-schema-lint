/** A command option */
export interface CommandOption {
  flag: string;
  value: string;
}

/** A builder for command line options */
export class CommandOptionsBuilder {
  private options: CommandOption[] = [];
  private commandName: string;

  constructor(commandName: string) {
    this.commandName = commandName;
  }

  addOption(flag: string, value: string): this {
    this.options.push({ flag, value });
    return this;
  }

  omitOptions(flagsToOmit: string[]): this {
    this.options = this.options.filter((option) => !flagsToOmit.includes(option.flag));
    return this;
  }

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

  clone(): CommandOptionsBuilder {
    const cloned = new CommandOptionsBuilder(this.commandName);
    cloned.options = [...this.options];
    return cloned;
  }
}

/**
 * @param commandName The command name to prefix args with
 * @returns A new CommandOptionsBuilder
 */
export function createCommandOptions(commandName: string): CommandOptionsBuilder {
  return new CommandOptionsBuilder(commandName);
}
