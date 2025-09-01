import EventEmitter from "node:events";
import parseArgsStringToArgv from "string-argv";
import { CommanderError } from "@commander-js/extra-typings";
import { Client, type Message } from "discord.js-selfbot-v13";
import { glob } from "glob";
import type { BotCommand, Module } from "./modules/index.js";
import type { BotConfig } from "./config.js";
import { getLogger } from "./utils/logger.js";

export type BotSettings = {
  config: BotConfig;
  modulesPath: string | URL;
};

export class Bot extends EventEmitter {
  private _config: BotConfig;
  private _client = new Client();
  private _initialized = false;

  private _allCommandsByName = new Map<string, [BotCommand, Module]>();
  private _allCommandsByModule = new Map<string, BotCommand[]>();

  public prefix;
  private logger = getLogger();

  constructor({ config, modulesPath }: BotSettings) {
    super();
    this._config = config;

    this.prefix = config.prefix;

    // Add error listener to Discord client
    this._client.on("error", (error) => {
      this.logger.error("Discord client error", { error: error.message });
    });
    this._client.on("warn", (warning) => {
      this.logger.warn("Discord client warning", { warning });
    });
    this._client.on("disconnect", () => {
      this.logger.info("Discord client disconnected");
    });

    (async () => {
      try {
        const modulesFile = (
          await glob("*/**/index.js", {
            cwd: modulesPath,
            dotRelative: true,
          })
        ).map((file) => new URL(file, `${modulesPath}/`).toString());
        const modules = await Promise.all(
          modulesFile.map((file) =>
            import(file).then((m) => m.default as Module),
          ),
        );
        for (const module of modules) {
          this.logger.info(`Registering module ${module.name}`, {
            module: module.name,
          });
          const commands = module.register(this);
          this._allCommandsByModule.set(module.name, commands);
          for (const command of commands) {
            const commandName = command.parser.name();
            const existingCommand = this._allCommandsByName.get(commandName);
            if (existingCommand) {
              this.logger.warn(
                `Command "${commandName}" already exists in module "${existingCommand[1].name}"`,
                {
                  command: commandName,
                  existingModule: existingCommand[1].name,
                  newModule: module.name,
                },
              );
              continue;
            }
            this._allCommandsByName.set(command.parser.name(), [
              command,
              module,
            ]);
          }
        }
        this._client.on("messageCreate", this._handleMessage.bind(this));
        this.client.on("ready", () => {
          this.logger.info("Bot is ready", { userTag: this._client.user?.tag });
          this._initialized = true;
          this.emit("ready");
        });
        await this._client.login(config.token);
      } catch (error) {
        this.logger.logError("Bot initialization error", {
          error: (error as Error).message,
          stack: (error as Error).stack,
        });
      }
    })();
  }

  private async _handleMessage(message: Message) {
    if (!message.content) return;

    if (message.content.startsWith(this.prefix)) {
      await this.executeCommand(
        message,
        message.content.slice(this.prefix.length).trim(),
      );
    }
  }

  public async executeCommand(message: Message, input: string) {
    const splitted = parseArgsStringToArgv(input);
    const command = splitted[0];
    const commandEntry = this._allCommandsByName.get(command);
    if (!commandEntry) {
      this.logger.warn(
        "Invalid command attempted",
        this.logger.createMessageContext(message, { command }),
      );
      message.reply(`Invalid command \`${command}\``);
      return;
    }
    const [program, module] = commandEntry;
    const { parser, handler } = program;
    try {
      const result = parser.parse(splitted.slice(1), { from: "user" });
      this.logger.logCommand(
        message,
        command,
        result.processedArgs,
        result.opts(),
        module.name,
      );
      await handler(message, result.processedArgs, result.opts());
    } catch (e: unknown) {
      if (e instanceof CommanderError) {
        this.logger.warn(
          "Command parsing error",
          this.logger.createMessageContext(message, {
            command,
            error: e.message,
            module: module.name,
          }),
        );
        let reply = "";
        reply += "```\n";
        reply += `${e.message}\n`;
        reply += "```\n";
        reply += "```\n";
        reply += `${parser.helpInformation()}\n`;
        reply += "```\n";
        message.reply(reply);
      } else {
        this.logger.logError(
          e instanceof Error ? e : String(e),
          this.logger.createMessageContext(message, {
            command,
            module: module.name,
          }),
        );
      }
    }
  }

  public get client() {
    return this._client;
  }

  public get initialized() {
    return this._initialized;
  }

  public get allCommandsByModule() {
    return this._allCommandsByModule;
  }

  public get allCommands() {
    return this._allCommandsByName;
  }

  public get config() {
    return this._config;
  }
}
