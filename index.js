/**
 * Module dependencies.
 */

var EventEmitter = require('events').EventEmitter;
var spawn = require('child_process').spawn;
var path = require('path');
var fs = require('fs');

class Option {
  /**
   * Initialize a new `Option` with the given `flags` and `description`.
   *
   * @param {String} flags
   * @param {String} description
   * @api public
   */

  constructor(flags, description) {
    this.flags = flags;
    this.required = flags.indexOf('<') >= 0; // A value must be supplied when the option is specified.
    this.optional = flags.indexOf('[') >= 0; // A value is optional when the option is specified.
    this.mandatory = false; // The option must have a value after parsing, which usually means it must be specified on command line.
    this.negate = flags.indexOf('-no-') !== -1;
    flags = flags.split(/[ ,|]+/);
    if (flags.length > 1 && !/^[[<]/.test(flags[1])) this.short = flags.shift();
    this.long = flags.shift();
    this.description = description || '';
  }

  /**
   * Return option name.
   *
   * @return {String}
   * @api private
   */

  name() {
    return this.long.replace(/^--/, '');
  };

  /**
   * Return option name, in a camelcase format that can be used
   * as a object attribute key.
   *
   * @return {String}
   * @api private
   */

  attributeName() {
    return camelcase(this.name().replace(/^no-/, ''));
  };

  /**
   * Check if `arg` matches the short or long flag.
   *
   * @param {String} arg
   * @return {Boolean}
   * @api private
   */

  is(arg) {
    return this.short === arg || this.long === arg;
  };
}

/**
 * CommanderError class
 * @class
 */
class CommanderError extends Error {
  /**
   * Constructs the CommanderError class
   * @param {Number} exitCode suggested exit code which could be used with process.exit
   * @param {String} code an id string representing the error
   * @param {String} message human-readable description of the error
   * @constructor
   */
  constructor(exitCode, code, message) {
    super(message);
    // properly capture stack trace in Node.js
    Error.captureStackTrace(this, this.constructor);
    this.name = this.constructor.name;
    this.code = code;
    this.exitCode = exitCode;
  }
}

class Command extends EventEmitter {
  /**
   * Initialize a new `Command`.
   *
   * @param {String} [name]
   * @api public
   */

  constructor(name) {
    super();
    this.commands = [];
    this.options = [];
    this._allowUnknownOption = false;
    this._args = [];
    this._name = name || '';
    this._optionValues = {};
    this._storeOptionsAsProperties = true; // backwards compatible by default
    this._passCommandToAction = true; // backwards compatible by default
    this._actionResults = [];
    this._actionHandler = null;
    this._executableHandler = false;
    this._executableFile = null; // custom name for executable
    this._defaultCommandName = null;
    this._exitCallback = null;

    this._noHelp = false;
    this._helpFlags = '-h, --help';
    this._helpDescription = 'display help for command';
    this._helpShortFlag = '-h';
    this._helpLongFlag = '--help';
    this._hasImplicitHelpCommand = undefined; // Deliberately undefined, not decided whether true or false
    this._helpCommandName = 'help';
    this._helpCommandnameAndArgs = 'help [command]';
    this._helpCommandDescription = 'display help for command';
  }

  /**
   * Define a command.
   *
   * There are two styles of command: pay attention to where to put the description.
   *
   * Examples:
   *
   *      // Command implemented using action handler (description is supplied separately to `.command`)
   *      program
   *        .command('clone <source> [destination]')
   *        .description('clone a repository into a newly created directory')
   *        .action((source, destination) => {
   *          console.log('clone command called');
   *        });
   *
   *      // Command implemented using separate executable file (description is second parameter to `.command`)
   *      program
   *        .command('start <service>', 'start named service')
   *        .command('stop [service]', 'stop named service, or all if no name supplied');
   *
   * @param {string} nameAndArgs - command name and arguments, args are `<required>` or `[optional]` and last may also be `variadic...`
   * @param {Object|string} [actionOptsOrExecDesc] - configuration options (for action), or description (for executable)
   * @param {Object} [execOpts] - configuration options (for executable)
   * @return {Command} returns new command for action handler, or top-level command for executable command
   * @api public
   */

  command(nameAndArgs, actionOptsOrExecDesc, execOpts) {
    var desc = actionOptsOrExecDesc;
    var opts = execOpts;
    if (typeof desc === 'object' && desc !== null) {
      opts = desc;
      desc = null;
    }
    opts = opts || {};
    var args = nameAndArgs.split(/ +/);
    var cmd = new Command(args.shift());

    if (desc) {
      cmd.description(desc);
      cmd._executableHandler = true;
    }
    if (opts.isDefault) this._defaultCommandName = cmd._name;

    cmd._noHelp = !!opts.noHelp;
    cmd._helpFlags = this._helpFlags;
    cmd._helpDescription = this._helpDescription;
    cmd._helpShortFlag = this._helpShortFlag;
    cmd._helpLongFlag = this._helpLongFlag;
    cmd._helpCommandName = this._helpCommandName;
    cmd._helpCommandnameAndArgs = this._helpCommandnameAndArgs;
    cmd._helpCommandDescription = this._helpCommandDescription;
    cmd._exitCallback = this._exitCallback;
    cmd._storeOptionsAsProperties = this._storeOptionsAsProperties;
    cmd._passCommandToAction = this._passCommandToAction;

    cmd._executableFile = opts.executableFile || null; // Custom name for executable file, set missing to null to match constructor
    this.commands.push(cmd);
    cmd._parseExpectedArgs(args);
    cmd.parent = this;

    if (desc) return this;
    return cmd;
  };

  /**
   * Add a prepared subcommand.
   *
   * @param {Command} cmd - new subcommand
   * @return {Command} parent command for chaining
   * @api public
   */

  addCommand(cmd) {
    if (!cmd._name) throw new Error('Command passed to .AddCommand must have a name');

    // To keep things simple, block automatic name generation for deeply nested executables.
    // Fail fast and detect when adding rather than later when parsing.
    function checkExplicitNames(commandArray) {
      commandArray.forEach((cmd) => {
        if (cmd._executableHandler && !cmd._executableFile) {
          throw new Error(`Must specify executableFile for deeply nested executable: ${cmd.name()}`);
        }
        checkExplicitNames(cmd.commands);
      });
    }
    checkExplicitNames(cmd.commands);

    this.commands.push(cmd);
    cmd.parent = this;
    return this;
  };

  /**
   * Define argument syntax for the top-level command.
   *
   * @api public
   */

  arguments(desc) {
    return this._parseExpectedArgs(desc.split(/ +/));
  };

  /**
   * Override default decision whether to add implicit help command.
   *
   *    addHelpCommand() // force on
   *    addHelpCommand(false); // force off
   *    addHelpCommand('help [cmd]', 'display help for [cmd]'); // force on with custom detais
   *
   * @return {Command} for chaining
   * @api public
   */

  addHelpCommand(enableOrNameAndArgs, description) {
    if (enableOrNameAndArgs === false) {
      this._hasImplicitHelpCommand = false;
    } else {
      this._hasImplicitHelpCommand = true;
      if (typeof enableOrNameAndArgs === 'string') {
        this._helpCommandName = enableOrNameAndArgs.split(' ')[0];
        this._helpCommandnameAndArgs = enableOrNameAndArgs;
      }
      this._helpCommandDescription = description || this._helpCommandDescription;
    }
    return this;
  };

  /**
   * @return {boolean}
   * @api private
   */

  _lazyHasImplicitHelpCommand() {
    if (this._hasImplicitHelpCommand === undefined) {
      this._hasImplicitHelpCommand = this.commands.length && !this._actionHandler && !this._findCommand('help');
    }
    return this._hasImplicitHelpCommand;
  };

  /**
   * Parse expected `args`.
   *
   * For example `["[type]"]` becomes `[{ required: false, name: 'type' }]`.
   *
   * @param {Array} args
   * @return {Command} for chaining
   * @api private
   */

  _parseExpectedArgs(args) {
    if (!args.length) return;
    var self = this;
    args.forEach(function(arg) {
      var argDetails = {
        required: false,
        name: '',
        variadic: false
      };

      switch (arg[0]) {
        case '<':
          argDetails.required = true;
          argDetails.name = arg.slice(1, -1);
          break;
        case '[':
          argDetails.name = arg.slice(1, -1);
          break;
      }

      if (argDetails.name.length > 3 && argDetails.name.slice(-3) === '...') {
        argDetails.variadic = true;
        argDetails.name = argDetails.name.slice(0, -3);
      }
      if (argDetails.name) {
        self._args.push(argDetails);
      }
    });
    return this;
  };

  /**
   * Register callback to use as replacement for calling process.exit.
   *
   * @param {Function} [fn] optional callback which will be passed a CommanderError, defaults to throwing
   * @return {Command} for chaining
   * @api public
   */

  exitOverride(fn) {
    if (fn) {
      this._exitCallback = fn;
    } else {
      this._exitCallback = function(err) {
        if (err.code !== 'commander.executeSubCommandAsync') {
          throw err;
        } else {
          // Async callback from spawn events, not useful to throw.
        }
      };
    }
    return this;
  };

  /**
   * Call process.exit, and _exitCallback if defined.
   *
   * @param {Number} exitCode exit code for using with process.exit
   * @param {String} code an id string representing the error
   * @param {String} message human-readable description of the error
   * @return never
   * @api private
   */

  _exit(exitCode, code, message) {
    if (this._exitCallback) {
      this._exitCallback(new CommanderError(exitCode, code, message));
      // Expecting this line is not reached.
    }
    process.exit(exitCode);
  };

  /**
   * Register callback `fn` for the command.
   *
   * Examples:
   *
   *      program
   *        .command('help')
   *        .description('display verbose help')
   *        .action(function() {
   *           // output help here
   *        });
   *
   * @param {Function} fn
   * @return {Command} for chaining
   * @api public
   */

  action(fn) {
    var self = this;
    var listener = function(args) {
      // The .action callback takes an extra parameter which is the command or options.
      var expectedArgsCount = self._args.length;
      var actionArgs = args.slice(0, expectedArgsCount);
      if (self._passCommandToAction) {
        actionArgs[expectedArgsCount] = self;
      } else {
        actionArgs[expectedArgsCount] = self.opts();
      }
      // Add the extra arguments so available too.
      if (args.length > expectedArgsCount) {
        actionArgs.push(args.slice(expectedArgsCount));
      }

      const actionResult = fn.apply(self, actionArgs);
      // Remember result in case it is async. Assume parseAsync getting called on root.
      let rootCommand = self;
      while (rootCommand.parent) {
        rootCommand = rootCommand.parent;
      }
      rootCommand._actionResults.push(actionResult);
    };
    this._actionHandler = listener;
    return this;
  };

  /**
   * Internal implementation shared by .option() and .requiredOption()
   *
   * @param {Object} config
   * @param {String} flags
   * @param {String} description
   * @param {Function|*} [fn] - custom option processing function or default vaue
   * @param {*} [defaultValue]
   * @return {Command} for chaining
   * @api private
   */

  _optionEx(config, flags, description, fn, defaultValue) {
    var self = this,
      option = new Option(flags, description),
      oname = option.name(),
      name = option.attributeName();
    option.mandatory = !!config.mandatory;

    // default as 3rd arg
    if (typeof fn !== 'function') {
      if (fn instanceof RegExp) {
        // This is a bit simplistic (especially no error messages), and probably better handled by caller using custom option processing.
        // No longer documented in README, but still present for backwards compatibility.
        var regex = fn;
        fn = function(val, def) {
          var m = regex.exec(val);
          return m ? m[0] : def;
        };
      } else {
        defaultValue = fn;
        fn = null;
      }
    }

    // preassign default value for --no-*, [optional], <required>, or plain flag if boolean value
    if (option.negate || option.optional || option.required || typeof defaultValue === 'boolean') {
      // when --no-foo we make sure default is true, unless a --foo option is already defined
      if (option.negate) {
        const positiveLongFlag = option.long.replace(/^--no-/, '--');
        defaultValue = self._findOption(positiveLongFlag) ? self._getOptionValue(name) : true;
      }
      // preassign only if we have a default
      if (defaultValue !== undefined) {
        self._setOptionValue(name, defaultValue);
        option.defaultValue = defaultValue;
      }
    }

    // register the option
    this.options.push(option);

    // when it's passed assign the value
    // and conditionally invoke the callback
    this.on('option:' + oname, function(val) {
      // coercion
      if (val !== null && fn) {
        val = fn(val, self._getOptionValue(name) === undefined ? defaultValue : self._getOptionValue(name));
      }

      // unassigned or boolean value
      if (typeof self._getOptionValue(name) === 'boolean' || typeof self._getOptionValue(name) === 'undefined') {
        // if no value, negate false, and we have a default, then use it!
        if (val == null) {
          self._setOptionValue(name, option.negate
            ? false
            : defaultValue || true);
        } else {
          self._setOptionValue(name, val);
        }
      } else if (val !== null) {
        // reassign
        self._setOptionValue(name, option.negate ? false : val);
      }
    });

    return this;
  };

  /**
   * Define option with `flags`, `description` and optional
   * coercion `fn`.
   *
   * The `flags` string should contain both the short and long flags,
   * separated by comma, a pipe or space. The following are all valid
   * all will output this way when `--help` is used.
   *
   *    "-p, --pepper"
   *    "-p|--pepper"
   *    "-p --pepper"
   *
   * Examples:
   *
   *     // simple boolean defaulting to undefined
   *     program.option('-p, --pepper', 'add pepper');
   *
   *     program.pepper
   *     // => undefined
   *
   *     --pepper
   *     program.pepper
   *     // => true
   *
   *     // simple boolean defaulting to true (unless non-negated option is also defined)
   *     program.option('-C, --no-cheese', 'remove cheese');
   *
   *     program.cheese
   *     // => true
   *
   *     --no-cheese
   *     program.cheese
   *     // => false
   *
   *     // required argument
   *     program.option('-C, --chdir <path>', 'change the working directory');
   *
   *     --chdir /tmp
   *     program.chdir
   *     // => "/tmp"
   *
   *     // optional argument
   *     program.option('-c, --cheese [type]', 'add cheese [marble]');
   *
   * @param {String} flags
   * @param {String} description
   * @param {Function|*} [fn] - custom option processing function or default vaue
   * @param {*} [defaultValue]
   * @return {Command} for chaining
   * @api public
   */

  option(flags, description, fn, defaultValue) {
    return this._optionEx({}, flags, description, fn, defaultValue);
  };

  /*
  * Add a required option which must have a value after parsing. This usually means
  * the option must be specified on the command line. (Otherwise the same as .option().)
  *
  * The `flags` string should contain both the short and long flags, separated by comma, a pipe or space.
  *
  * @param {String} flags
  * @param {String} description
  * @param {Function|*} [fn] - custom option processing function or default vaue
  * @param {*} [defaultValue]
  * @return {Command} for chaining
  * @api public
  */

  requiredOption(flags, description, fn, defaultValue) {
    return this._optionEx({ mandatory: true }, flags, description, fn, defaultValue);
  };

  /**
   * Allow unknown options on the command line.
   *
   * @param {Boolean} arg if `true` or omitted, no error will be thrown
   * for unknown options.
   * @api public
   */
  allowUnknownOption(arg) {
    this._allowUnknownOption = arguments.length === 0 || arg;
    return this;
  };

  /**
    * Whether to store option values as properties on command object,
    * or store separately (specify false). In both cases the option values can be accessed using .opts().
    *
    * @param {boolean} value
    * @return {Command} Command for chaining
    * @api public
    */

  storeOptionsAsProperties(value) {
    this._storeOptionsAsProperties = (value === undefined) || value;
    if (this.options.length) {
      // This is for programmer, not end user.
      console.error('Commander usage error: call storeOptionsAsProperties before adding options');
    }
    return this;
  };

  /**
    * Whether to pass command to action handler,
    * or just the options (specify false).
    *
    * @param {boolean} value
    * @return {Command} Command for chaining
    * @api public
    */

  passCommandToAction(value) {
    this._passCommandToAction = (value === undefined) || value;
    return this;
  };

  /**
   * Store option value
   *
   * @param {String} key
   * @param {Object} value
   * @api private
   */

  _setOptionValue(key, value) {
    if (this._storeOptionsAsProperties) {
      this[key] = value;
    } else {
      this._optionValues[key] = value;
    }
  };

  /**
   * Retrieve option value
   *
   * @param {String} key
   * @return {Object} value
   * @api private
   */

  _getOptionValue(key) {
    if (this._storeOptionsAsProperties) {
      return this[key];
    }
    return this._optionValues[key];
  };

  /**
   * Parse `argv`, setting options and invoking commands when defined.
   *
   * @param {Array} argv
   * @return {Command} for chaining
   * @api public
   */

  parse(argv) {
    // store raw args
    this.rawArgs = argv;

    // Guess name, used in usage in help.
    this._name = this._name || path.basename(argv[1], path.extname(argv[1]));

    this._parseCommand([], argv.slice(2));

    return this;
  };

  /**
   * Parse `argv`, setting options and invoking commands when defined.
   *
   * Use parseAsync instead of parse if any of your action handlers are async. Returns a Promise.
   *
   * @param {Array} argv
   * @return {Promise}
   * @api public
   */

  parseAsync(argv) {
    this.parse(argv);
    return Promise.all(this._actionResults);
  };

  /**
   * Execute a sub-command executable.
   *
   * @api private
   */

  _executeSubCommand(subcommand, args) {
    args = args.slice();
    let launchWithNode = false; // Use node for source targets so do not need to get permissions correct, and on Windows.
    const sourceExt = ['.js', '.ts', '.mjs'];

    // Not checking for help first. Unlikely to have mandatory and executable, and can't robustly test for help flags in external command.
    this._checkForMissingMandatoryOptions();

    // Want the entry script as the reference for command name and directory for searching for other files.
    const scriptPath = this.rawArgs[1];

    let baseDir;
    try {
      const resolvedLink = fs.realpathSync(scriptPath);
      baseDir = path.dirname(resolvedLink);
    } catch (e) {
      baseDir = '.'; // dummy, probably not going to find executable!
    }

    // name of the subcommand, like `pm-install`
    let bin = path.basename(scriptPath, path.extname(scriptPath)) + '-' + subcommand._name;
    if (subcommand._executableFile) {
      bin = subcommand._executableFile;
    }

    const localBin = path.join(baseDir, bin);
    if (fs.existsSync(localBin)) {
      // prefer local `./<bin>` to bin in the $PATH
      bin = localBin;
    } else {
      // Look for source files.
      sourceExt.forEach((ext) => {
        if (fs.existsSync(`${localBin}${ext}`)) {
          bin = `${localBin}${ext}`;
        }
      });
    }
    launchWithNode = sourceExt.includes(path.extname(bin));

    let proc;
    if (process.platform !== 'win32') {
      if (launchWithNode) {
        args.unshift(bin);
        // add executable arguments to spawn
        args = incrementNodeInspectorPort(process.execArgv).concat(args);

        proc = spawn(process.argv[0], args, { stdio: 'inherit' });
      } else {
        proc = spawn(bin, args, { stdio: 'inherit' });
      }
    } else {
      args.unshift(bin);
      // add executable arguments to spawn
      args = incrementNodeInspectorPort(process.execArgv).concat(args);
      proc = spawn(process.execPath, args, { stdio: 'inherit' });
    }

    const signals = ['SIGUSR1', 'SIGUSR2', 'SIGTERM', 'SIGINT', 'SIGHUP'];
    signals.forEach(function(signal) {
      process.on(signal, function() {
        if (proc.killed === false && proc.exitCode === null) {
          proc.kill(signal);
        }
      });
    });

    // By default terminate process when spawned process terminates.
    // Suppressing the exit if exitCallback defined is a bit messy and of limited use, but does allow process to stay running!
    const exitCallback = this._exitCallback;
    if (!exitCallback) {
      proc.on('close', process.exit.bind(process));
    } else {
      proc.on('close', () => {
        exitCallback(new CommanderError(process.exitCode || 0, 'commander.executeSubCommandAsync', '(close)'));
      });
    }
    proc.on('error', function(err) {
      if (err.code === 'ENOENT') {
        console.error('error: %s(1) does not exist', bin);
      } else if (err.code === 'EACCES') {
        console.error('error: %s(1) not executable', bin);
      }
      if (!exitCallback) {
        process.exit(1);
      } else {
        const wrappedError = new CommanderError(1, 'commander.executeSubCommandAsync', '(error)');
        wrappedError.nestedError = err;
        exitCallback(wrappedError);
      }
    });

    // Store the reference to the child process
    this.runningCommand = proc;
  };

  /**
   * @api private
   */
  _dispatchSubcommand(commandName, operands, unknown) {
    const subCommand = this._findCommand(commandName);
    if (!subCommand) this._helpAndError();

    if (subCommand._executableHandler) {
      this._executeSubCommand(subCommand, operands.concat(unknown));
    } else {
      subCommand._parseCommand(operands, unknown);
    }
  };

  /**
   * Process arguments in context of this command.
   *
   * @api private
   */

  _parseCommand(operands, unknown) {
    const parsed = this.parseOptions(unknown);
    operands = operands.concat(parsed.operands);
    unknown = parsed.unknown;
    this.args = operands.concat(unknown);

    if (operands && this._findCommand(operands[0])) {
      this._dispatchSubcommand(operands[0], operands.slice(1), unknown);
    } else if (this._lazyHasImplicitHelpCommand() && operands[0] === this._helpCommandName) {
      if (operands.length === 1) {
        this.help();
      } else {
        this._dispatchSubcommand(operands[1], [], [this._helpLongFlag]);
      }
    } else if (this._defaultCommandName) {
      outputHelpIfRequested(this, unknown); // Run the help for default command from parent rather than passing to default command
      this._dispatchSubcommand(this._defaultCommandName, operands, unknown);
    } else {
      if (this.commands.length && this.args.length === 0 && !this._actionHandler && !this._defaultCommandName) {
        // probaby missing subcommand and no handler, user needs help
        this._helpAndError();
      }

      outputHelpIfRequested(this, parsed.unknown);
      this._checkForMissingMandatoryOptions();
      if (parsed.unknown.length > 0) {
        this.unknownOption(parsed.unknown[0]);
      }

      if (this._actionHandler) {
        const self = this;
        const args = this.args.slice();
        this._args.forEach(function(arg, i) {
          if (arg.required && args[i] == null) {
            self.missingArgument(arg.name);
          } else if (arg.variadic) {
            if (i !== self._args.length - 1) {
              self.variadicArgNotLast(arg.name);
            }

            args[i] = args.splice(i);
          }
        });

        this._actionHandler(args);
        this.emit('command:' + this.name(), operands, unknown);
      } else if (operands.length) {
        if (this._findCommand('*')) {
          this._dispatchSubcommand('*', operands, unknown);
        } else if (this.listenerCount('command:*')) {
          this.emit('command:*', operands, unknown);
        } else if (this.commands.length) {
          this.unknownCommand();
        }
      } else if (this.commands.length) {
        // This command has subcommands and nothing hooked up at this level, so display help.
        this._helpAndError();
      } else {
        // fall through for caller to handle after calling .parse()
      }
    }
  };

  /**
   * Find matching command.
   *
   * @api private
   */
  _findCommand(name) {
    if (!name) return undefined;
    return this.commands.find(cmd => cmd._name === name || cmd._alias === name);
  };

  /**
   * Return an option matching `arg` if any.
   *
   * @param {String} arg
   * @return {Option}
   * @api private
   */

  _findOption(arg) {
    return this.options.find(option => option.is(arg));
  };

  /**
   * Display an error message if a mandatory option does not have a value.
   * Lazy calling after checking for help flags from leaf subcommand.
   *
   * @api private
   */

  _checkForMissingMandatoryOptions() {
    // Walk up hierarchy so can call in subcommand after checking for displaying help.
    for (var cmd = this; cmd; cmd = cmd.parent) {
      cmd.options.forEach((anOption) => {
        if (anOption.mandatory && (cmd._getOptionValue(anOption.attributeName()) === undefined)) {
          cmd.missingMandatoryOptionValue(anOption);
        }
      });
    }
  };

  /**
   * Parse options from `argv` removing known options,
   * and return argv split into operands and unknown arguments.
   *
   * Examples:
   *
   *    argv => operands, unknown
   *    --known kkk op => [op], []
   *    op --known kkk => [op], []
   *    sub --unknown uuu op => [sub], [--unknown uuu op]
   *    sub -- --unknown uuu op => [sub --unknown uuu op], []
   *
   * @param {String[]} argv
   * @return {{operands: String[], unknown: String[]}}
   * @api public
   */

  parseOptions(argv) {
    const operands = []; // operands, not options or values
    const unknown = []; // first unknown option and remaining unknown args
    let dest = operands;
    const args = argv.slice();

    function maybeOption(arg) {
      return arg.length > 1 && arg[0] === '-';
    }

    // parse options
    while (args.length) {
      const arg = args.shift();

      // literal
      if (arg === '--') {
        if (dest === unknown) dest.push(arg);
        dest.push(...args);
        break;
      }

      if (maybeOption(arg)) {
        const option = this._findOption(arg);
        // recognised option, call listener to assign value with possible custom processing
        if (option) {
          if (option.required) {
            const value = args.shift();
            if (value === undefined) this.optionMissingArgument(option);
            this.emit(`option:${option.name()}`, value);
          } else if (option.optional) {
            let value = null;
            // historical behaviour is optional value is following arg unless an option
            if (args.length > 0 && !maybeOption(args[0])) {
              value = args.shift();
            }
            this.emit(`option:${option.name()}`, value);
          } else { // boolean flag
            this.emit(`option:${option.name()}`);
          }
          continue;
        }
      }

      // Look for combo options following single dash, eat first one if known.
      if (arg.length > 2 && arg[0] === '-' && arg[1] !== '-') {
        const option = this._findOption(`-${arg[1]}`);
        if (option) {
          if (option.required || option.optional) {
            // option with value following in same argument
            this.emit(`option:${option.name()}`, arg.slice(2));
          } else {
            // boolean option, emit and put back remainder of arg for further processing
            this.emit(`option:${option.name()}`);
            args.unshift(`-${arg.slice(2)}`);
          }
          continue;
        }
      }

      // Look for known long flag with value, like --foo=bar
      if (/^--[^=]+=/.test(arg)) {
        const index = arg.indexOf('=');
        const option = this._findOption(arg.slice(0, index));
        if (option && (option.required || option.optional)) {
          this.emit(`option:${option.name()}`, arg.slice(index + 1));
          continue;
        }
      }

      // looks like an option but unknown, unknowns from here
      if (arg.length > 1 && arg[0] === '-') {
        dest = unknown;
      }

      // add arg
      dest.push(arg);
    }

    return { operands, unknown };
  };

  /**
   * Return an object containing options as key-value pairs
   *
   * @return {Object}
   * @api public
   */
  opts() {
    if (this._storeOptionsAsProperties) {
      // Preserve original behaviour so backwards compatible when still using properties
      var result = {},
        len = this.options.length;

      for (var i = 0; i < len; i++) {
        var key = this.options[i].attributeName();
        result[key] = key === this._versionOptionName ? this._version : this[key];
      }
      return result;
    }

    return this._optionValues;
  };

  /**
   * Argument `name` is missing.
   *
   * @param {String} name
   * @api private
   */

  missingArgument(name) {
    const message = `error: missing required argument '${name}'`;
    console.error(message);
    this._exit(1, 'commander.missingArgument', message);
  };

  /**
   * `Option` is missing an argument, but received `flag` or nothing.
   *
   * @param {Option} option
   * @param {String} [flag]
   * @api private
   */

  optionMissingArgument(option, flag) {
    let message;
    if (flag) {
      message = `error: option '${option.flags}' argument missing, got '${flag}'`;
    } else {
      message = `error: option '${option.flags}' argument missing`;
    }
    console.error(message);
    this._exit(1, 'commander.optionMissingArgument', message);
  };

  /**
   * `Option` does not have a value, and is a mandatory option.
   *
   * @param {Option} option
   * @api private
   */

  missingMandatoryOptionValue(option) {
    const message = `error: required option '${option.flags}' not specified`;
    console.error(message);
    this._exit(1, 'commander.missingMandatoryOptionValue', message);
  };

  /**
   * Unknown option `flag`.
   *
   * @param {String} flag
   * @api private
   */

  unknownOption(flag) {
    if (this._allowUnknownOption) return;
    const message = `error: unknown option '${flag}'`;
    console.error(message);
    this._exit(1, 'commander.unknownOption', message);
  };

  /**
   * Unknown command.
   *
   * @param {String} flag
   * @api private
   */

  unknownCommand() {
    const message = `error: unknown command '${this.args[0]}'`;
    console.error(message);
    this._exit(1, 'commander.unknownCommand', message);
  };

  /**
   * Variadic argument with `name` is not the last argument as required.
   *
   * @param {String} name
   * @api private
   */

  variadicArgNotLast(name) {
    const message = `error: variadic arguments must be last '${name}'`;
    console.error(message);
    this._exit(1, 'commander.variadicArgNotLast', message);
  };

  /**
   * Set the program version to `str`.
   *
   * This method auto-registers the "-V, --version" flag
   * which will print the version number when passed.
   *
   * You can optionally supply the  flags and description to override the defaults.
   *
   * @param {String} str
   * @param {String} [flags]
   * @param {String} [description]
   * @return {Command} for chaining
   * @api public
   */

  version(str, flags, description) {
    if (arguments.length === 0) return this._version;
    this._version = str;
    flags = flags || '-V, --version';
    description = description || 'output the version number';
    var versionOption = new Option(flags, description);
    this._versionOptionName = versionOption.long.substr(2) || 'version';
    this.options.push(versionOption);
    var self = this;
    this.on('option:' + this._versionOptionName, function() {
      process.stdout.write(str + '\n');
      self._exit(0, 'commander.version', str);
    });
    return this;
  };

  /**
   * Set the description to `str`.
   *
   * @param {String} str
   * @param {Object} [argsDescription]
   * @return {String|Command}
   * @api public
   */

  description(str, argsDescription) {
    if (arguments.length === 0) return this._description;
    this._description = str;
    this._argsDescription = argsDescription;
    return this;
  };

  /**
   * Set an alias for the command
   *
   * @param {String} alias
   * @return {String|Command}
   * @api public
   */

  alias(alias) {
    var command = this;
    if (this.commands.length !== 0) {
      command = this.commands[this.commands.length - 1];
    }

    if (arguments.length === 0) return command._alias;

    if (alias === command._name) throw new Error('Command alias can\'t be the same as its name');

    command._alias = alias;
    return this;
  };

  /**
   * Set / get the command usage `str`.
   *
   * @param {String} [str]
   * @return {String|Command}
   * @api public
   */

  usage(str) {
    var args = this._args.map(function(arg) {
      return humanReadableArgName(arg);
    });

    var usage = '[options]' +
      (this.commands.length ? ' [command]' : '') +
      (this._args.length ? ' ' + args.join(' ') : '');

    if (arguments.length === 0) return this._usage || usage;
    this._usage = str;

    return this;
  };

  /**
   * Get or set the name of the command
   *
   * @param {String} [str]
   * @return {String|Command}
   * @api public
   */

  name(str) {
    if (arguments.length === 0) return this._name;
    this._name = str;
    return this;
  };

  /**
   * Return prepared commands.
   *
   * @return {Array}
   * @api private
   */

  prepareCommands() {
    const commandDetails = this.commands.filter(function(cmd) {
      return !cmd._noHelp;
    }).map(function(cmd) {
      var args = cmd._args.map(function(arg) {
        return humanReadableArgName(arg);
      }).join(' ');

      return [
        cmd._name +
          (cmd._alias ? '|' + cmd._alias : '') +
          (cmd.options.length ? ' [options]' : '') +
          (args ? ' ' + args : ''),
        cmd._description
      ];
    });

    if (this._lazyHasImplicitHelpCommand()) {
      commandDetails.push([this._helpCommandnameAndArgs, this._helpCommandDescription]);
    }
    return commandDetails;
  };

  /**
   * Return the largest command length.
   *
   * @return {Number}
   * @api private
   */

  largestCommandLength() {
    var commands = this.prepareCommands();
    return commands.reduce(function(max, command) {
      return Math.max(max, command[0].length);
    }, 0);
  };

  /**
   * Return the largest option length.
   *
   * @return {Number}
   * @api private
   */

  largestOptionLength() {
    var options = [].slice.call(this.options);
    options.push({
      flags: this._helpFlags
    });

    return options.reduce(function(max, option) {
      return Math.max(max, option.flags.length);
    }, 0);
  };

  /**
   * Return the largest arg length.
   *
   * @return {Number}
   * @api private
   */

  largestArgLength() {
    return this._args.reduce(function(max, arg) {
      return Math.max(max, arg.name.length);
    }, 0);
  };

  /**
   * Return the pad width.
   *
   * @return {Number}
   * @api private
   */

  padWidth() {
    var width = this.largestOptionLength();
    if (this._argsDescription && this._args.length) {
      if (this.largestArgLength() > width) {
        width = this.largestArgLength();
      }
    }

    if (this.commands && this.commands.length) {
      if (this.largestCommandLength() > width) {
        width = this.largestCommandLength();
      }
    }

    return width;
  };

  /**
   * Return help for options.
   *
   * @return {String}
   * @api private
   */

  optionHelp() {
    var width = this.padWidth();

    var columns = process.stdout.columns || 80;
    var descriptionWidth = columns - width - 4;

    // Append the help information
    return this.options.map(function(option) {
      const fullDesc = option.description +
        ((!option.negate && option.defaultValue !== undefined) ? ' (default: ' + JSON.stringify(option.defaultValue) + ')' : '');
      return pad(option.flags, width) + '  ' + optionalWrap(fullDesc, descriptionWidth, width + 2);
    }).concat([pad(this._helpFlags, width) + '  ' + optionalWrap(this._helpDescription, descriptionWidth, width + 2)])
      .join('\n');
  };

  /**
   * Return command help documentation.
   *
   * @return {String}
   * @api private
   */

  commandHelp() {
    if (!this.commands.length && !this._lazyHasImplicitHelpCommand()) return '';

    var commands = this.prepareCommands();
    var width = this.padWidth();

    var columns = process.stdout.columns || 80;
    var descriptionWidth = columns - width - 4;

    return [
      'Commands:',
      commands.map(function(cmd) {
        var desc = cmd[1] ? '  ' + cmd[1] : '';
        return (desc ? pad(cmd[0], width) : cmd[0]) + optionalWrap(desc, descriptionWidth, width + 2);
      }).join('\n').replace(/^/gm, '  '),
      ''
    ].join('\n');
  };

  /**
   * Return program help documentation.
   *
   * @return {String}
   * @api private
   */

  helpInformation() {
    var desc = [];
    if (this._description) {
      desc = [
        this._description,
        ''
      ];

      var argsDescription = this._argsDescription;
      if (argsDescription && this._args.length) {
        var width = this.padWidth();
        var columns = process.stdout.columns || 80;
        var descriptionWidth = columns - width - 5;
        desc.push('Arguments:');
        desc.push('');
        this._args.forEach(function(arg) {
          desc.push('  ' + pad(arg.name, width) + '  ' + wrap(argsDescription[arg.name], descriptionWidth, width + 4));
        });
        desc.push('');
      }
    }

    var cmdName = this._name;
    if (this._alias) {
      cmdName = cmdName + '|' + this._alias;
    }
    var parentCmdNames = '';
    for (var parentCmd = this.parent; parentCmd; parentCmd = parentCmd.parent) {
      parentCmdNames = parentCmd.name() + ' ' + parentCmdNames;
    }
    var usage = [
      'Usage: ' + parentCmdNames + cmdName + ' ' + this.usage(),
      ''
    ];

    var cmds = [];
    var commandHelp = this.commandHelp();
    if (commandHelp) cmds = [commandHelp];

    var options = [
      'Options:',
      '' + this.optionHelp().replace(/^/gm, '  '),
      ''
    ];

    return usage
      .concat(desc)
      .concat(options)
      .concat(cmds)
      .join('\n');
  };

  /**
   * Output help information for this command.
   *
   * When listener(s) are available for the helpLongFlag
   * those callbacks are invoked.
   *
   * @api public
   */

  outputHelp(cb) {
    if (!cb) {
      cb = function(passthru) {
        return passthru;
      };
    }
    const cbOutput = cb(this.helpInformation());
    if (typeof cbOutput !== 'string' && !Buffer.isBuffer(cbOutput)) {
      throw new Error('outputHelp callback must return a string or a Buffer');
    }
    process.stdout.write(cbOutput);
    this.emit(this._helpLongFlag);
  };

  /**
   * You can pass in flags and a description to override the help
   * flags and help description for your command.
   *
   * @param {String} [flags]
   * @param {String} [description]
   * @return {Command}
   * @api public
   */

  helpOption(flags, description) {
    this._helpFlags = flags || this._helpFlags;
    this._helpDescription = description || this._helpDescription;

    var splitFlags = this._helpFlags.split(/[ ,|]+/);

    if (splitFlags.length > 1) this._helpShortFlag = splitFlags.shift();

    this._helpLongFlag = splitFlags.shift();

    return this;
  };

  /**
   * Output help information and exit.
   *
   * @param {Function} [cb]
   * @api public
   */

  help(cb) {
    this.outputHelp(cb);
    // exitCode: preserving original behaviour which was calling process.exit()
    // message: do not have all displayed text available so only passing placeholder.
    this._exit(process.exitCode || 0, 'commander.help', '(outputHelp)');
  };

  /**
   * Output help information and exit. Display for error situations.
   *
   * @api private
   */

  _helpAndError() {
    this.outputHelp();
    // message: do not have all displayed text available so only passing placeholder.
    this._exit(1, 'commander.help', '(outputHelp)');
  };
};

/**
 * Expose the root command.
 */

exports = module.exports = new Command();

/**
 * Expose classes
 */

exports.Command = Command;
exports.Option = Option;
exports.CommanderError = CommanderError;

/**
 * Camel-case the given `flag`
 *
 * @param {String} flag
 * @return {String}
 * @api private
 */

function camelcase(flag) {
  return flag.split('-').reduce(function(str, word) {
    return str + word[0].toUpperCase() + word.slice(1);
  });
}

/**
 * Pad `str` to `width`.
 *
 * @param {String} str
 * @param {Number} width
 * @return {String}
 * @api private
 */

function pad(str, width) {
  var len = Math.max(0, width - str.length);
  return str + Array(len + 1).join(' ');
}

/**
 * Wraps the given string with line breaks at the specified width while breaking
 * words and indenting every but the first line on the left.
 *
 * @param {String} str
 * @param {Number} width
 * @param {Number} indent
 * @return {String}
 * @api private
 */
function wrap(str, width, indent) {
  var regex = new RegExp('.{1,' + (width - 1) + '}([\\s\u200B]|$)|[^\\s\u200B]+?([\\s\u200B]|$)', 'g');
  var lines = str.match(regex) || [];
  return lines.map(function(line, i) {
    if (line.slice(-1) === '\n') {
      line = line.slice(0, line.length - 1);
    }
    return ((i > 0 && indent) ? Array(indent + 1).join(' ') : '') + line.trimRight();
  }).join('\n');
}

/**
 * Optionally wrap the given str to a max width of width characters per line
 * while indenting with indent spaces. Do not wrap if insufficient width or
 * string is manually formatted.
 *
 * @param {String} str
 * @param {Number} width
 * @param {Number} indent
 * @return {String}
 * @api private
 */
function optionalWrap(str, width, indent) {
  // Detect manually wrapped and indented strings by searching for line breaks
  // followed by multiple spaces/tabs.
  if (str.match(/[\n]\s+/)) return str;
  // Do not wrap to narrow columns (or can end up with a word per line).
  const minWidth = 40;
  if (width < minWidth) return str;

  return wrap(str, width, indent);
}

/**
 * Output help information if help flags specified
 *
 * @param {Command} cmd - command to output help for
 * @param {Array} args - array of options to search for help flags
 * @api private
 */

function outputHelpIfRequested(cmd, args) {
  const helpOption = args.find(arg => arg === cmd._helpLongFlag || arg === cmd._helpShortFlag);
  if (helpOption) {
    cmd.outputHelp();
    // (Do not have all displayed text available so only passing placeholder.)
    cmd._exit(0, 'commander.helpDisplayed', '(outputHelp)');
  }
}

/**
 * Takes an argument and returns its human readable equivalent for help usage.
 *
 * @param {Object} arg
 * @return {String}
 * @api private
 */

function humanReadableArgName(arg) {
  var nameOutput = arg.name + (arg.variadic === true ? '...' : '');

  return arg.required
    ? '<' + nameOutput + '>'
    : '[' + nameOutput + ']';
}

/**
 * Scan arguments and increment port number for inspect calls (to avoid conflicts when spawning new command).
 *
 * @param {string[]} args - array of arguments from node.execArgv
 * @returns {string[]}
 * @api private
 */

function incrementNodeInspectorPort(args) {
  // Testing for these options:
  //  --inspect[=[host:]port]
  //  --inspect-brk[=[host:]port]
  //  --inspect-port=[host:]port
  return args.map((arg) => {
    var result = arg;
    if (arg.indexOf('--inspect') === 0) {
      var debugOption;
      var debugHost = '127.0.0.1';
      var debugPort = '9229';
      var match;
      if ((match = arg.match(/^(--inspect(-brk)?)$/)) !== null) {
        // e.g. --inspect
        debugOption = match[1];
      } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+)$/)) !== null) {
        debugOption = match[1];
        if (/^\d+$/.test(match[3])) {
          // e.g. --inspect=1234
          debugPort = match[3];
        } else {
          // e.g. --inspect=localhost
          debugHost = match[3];
        }
      } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+):(\d+)$/)) !== null) {
        // e.g. --inspect=localhost:1234
        debugOption = match[1];
        debugHost = match[3];
        debugPort = match[4];
      }

      if (debugOption && debugPort !== '0') {
        result = `${debugOption}=${debugHost}:${parseInt(debugPort) + 1}`;
      }
    }
    return result;
  });
}
