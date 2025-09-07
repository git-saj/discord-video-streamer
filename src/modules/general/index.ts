import { Command } from "@commander-js/extra-typings";
import { createCommand } from "../index.js";
import type { Module } from "../index.js";
import type { Bot } from "../../bot.js";
import { getLogger } from "../../utils/logger.js";

interface StreamingState {
  isStreaming: boolean;
  isProcessing: boolean;
  queueLength: number;
  currentStream: string | null;
  voiceConnection: {
    guildId: string | null;
    channelId: string;
    ready: boolean;
  } | null;
}

interface BotWithStreaming extends Bot {
  streamingState?: StreamingState;
}

export default {
  name: "general",
  register(bot) {
    const { allCommandsByModule, allCommands } = bot;
    return [
      createCommand(
        new Command("help")
          .description("Get comprehensive help information")
          .argument("[command]", "Get detailed help for a specific command")
          .option("--status", "Show bot status information only"),
        (message, args, opts) => {
          // Get streaming state if available
          const streamingState = (bot as BotWithStreaming).streamingState;

          if (opts.status) {
            const statusInfo = getBotStatus(bot, streamingState);
            message.reply(statusInfo);
            return;
          }

          if (args[0]) {
            const command = allCommands.get(args[0])?.[0];
            if (!command) {
              message.reply(
                `❌ Command \`${args[0]}\` doesn't exist. Use \`${bot.prefix}help\` to see all commands.`,
              );
              return;
            }

            const detailedHelp = getDetailedCommandHelp(
              command as unknown,
              bot.prefix,
            );
            message.reply(detailedHelp);
            return;
          }

          // Show comprehensive help
          const helpMessage = getComprehensiveHelp(
            bot,
            allCommandsByModule,
            streamingState,
          );
          message.reply(helpMessage);
        },
      ),
      createCommand(
        new Command("restart").description(
          "Restart the bot by killing the container",
        ),
        async (message) => {
          const logger = getLogger();
          logger.info("Restart command received, shutting down gracefully...", {
            user: message.author.tag,
            channel: message.channel.id,
          });
          await message.reply("🔄 Restarting bot... This will take a moment.");
          process.exit(0);
        },
      ),
    ] as const;
  },
} satisfies Module;

function getBotStatus(bot: Bot, streamingState?: StreamingState): string {
  const uptime = process.uptime();
  const uptimeFormatted = formatUptime(uptime);
  const memoryUsage = process.memoryUsage();
  const memoryMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);

  let status = "";
  status += "🤖 **Bot Status**\n";
  status += `├ **Status:** ${bot.client.isReady() ? "🟢 Online" : "🔴 Offline"}\n`;
  status += `├ **User:** ${bot.client.user?.tag || "Not logged in"}\n`;
  status += `├ **Guilds:** ${bot.client.guilds.cache.size}\n`;
  status += `├ **Uptime:** ${uptimeFormatted}\n`;
  status += `├ **Memory:** ${memoryMB} MB\n`;
  status += `└ **Prefix:** \`${bot.prefix}\`\n\n`;

  if (streamingState) {
    status += "🎵 **Streaming Status**\n";
    status += `├ **Active:** ${streamingState.isStreaming ? "🟢 Yes" : "🔴 No"}\n`;
    status += `├ **Processing:** ${streamingState.isProcessing ? "🟡 Yes" : "⚫ No"}\n`;
    status += `├ **Queue Length:** ${streamingState.queueLength}\n`;
    status += `└ **Current Stream:** ${streamingState.currentStream || "None"}\n\n`;

    if (streamingState.voiceConnection) {
      const vc = streamingState.voiceConnection;
      status += "🔊 **Voice Connection**\n";
      status += `├ **Guild ID:** ${vc.guildId || "Unknown"}\n`;
      status += `├ **Channel ID:** ${vc.channelId}\n`;
      status += `└ **Ready:** ${vc.ready ? "🟢 Yes" : "🔴 No"}\n`;
    }
  }

  return status;
}

function getDetailedCommandHelp(command: unknown, prefix: string): string {
  const parser = (
    command as { parser: { name(): string; description(): string } }
  ).parser;
  const name = parser.name();
  const description = parser.description() || "No description available";

  let help = "";
  help += `📖 **Command: \`${name}\`**\n`;
  help += `${description}\n\n`;

  // Usage
  help += "**Usage:**\n";
  help += `\`${prefix}${name}`;

  // Add arguments
  const args =
    (parser as { _args?: { name(): string; required: boolean }[] })._args || [];
  for (const arg of args) {
    if (arg.required) {
      help += ` <${arg.name()}>`;
    } else {
      help += ` [${arg.name()}]`;
    }
  }
  help += "`\n\n";

  // Add options
  const options =
    (
      parser as {
        options?: {
          short?: string;
          long: string;
          description?: string;
          argChoices?: string[];
          args?: unknown[];
        }[];
      }
    ).options || [];
  if (options.length > 0) {
    help += "**Options:**\n";
    for (const option of options) {
      if (option.long === "--help") continue; // Skip help option

      let optionLine = "├ ";
      if (option.short) {
        optionLine += `\`${option.short}\`, `;
      }
      optionLine += `\`${option.long}\``;

      if (option.argChoices && option.argChoices.length > 0) {
        optionLine += ` <${option.argChoices.join("|")}>`;
      } else if (option.args && option.args.length > 0) {
        optionLine += " <value>";
      }

      optionLine += ` - ${option.description || "No description"}`;
      help += `${optionLine}\n`;
    }
    help += "\n";
  }

  // Add examples based on command name
  const examples = getCommandExamples(name, prefix);
  if (examples.length > 0) {
    help += "**Examples:**\n";
    for (const example of examples) {
      help += `├ \`${example}\`\n`;
    }
  }

  return help;
}

function getComprehensiveHelp(
  bot: Bot,
  allCommandsByModule: Map<
    string,
    { parser: { name(): string; description(): string } }[]
  >,
  streamingState?: StreamingState,
): string {
  let help = "";

  // Bot status header
  help += getBotStatus(bot, streamingState);
  help += "\n";

  // Commands overview
  help += "📋 **Available Commands**\n";
  help += `Use \`${bot.prefix}help <command>\` for detailed information\n\n`;

  for (const [moduleName, commands] of allCommandsByModule.entries()) {
    const moduleIcon = getModuleIcon(moduleName);
    help += `${moduleIcon} **${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)} Module**\n`;

    for (const command of commands) {
      const name = command.parser.name();
      const desc = command.parser.description() || "No description";
      help += `├ \`${name}\` - ${desc}\n`;
    }
    help += "\n";
  }

  // Quick tips
  help += "💡 **Quick Tips**\n";
  help += `├ Use \`${bot.prefix}help --status\` for detailed bot status\n`;
  help += `├ Use \`${bot.prefix}help <command>\` for command details\n`;
  help += "├ Bot responds to users, bots, and webhooks\n";
  help += "└ Health checks available on port 8080\n";

  return help;
}

function getModuleIcon(moduleName: string): string {
  const icons: { [key: string]: string } = {
    stream: "🎵",
    general: "⚙️",
    mediamtx: "📡",
    default: "📦",
  };
  return icons[moduleName] || icons.default;
}

function getCommandExamples(commandName: string, prefix: string): string[] {
  const examples: { [key: string]: string[] } = {
    play: [
      `${prefix}play https://www.youtube.com/watch?v=dQw4w9WgXcQ`,
      `${prefix}play video.mp4 --now`,
      `${prefix}play https://stream.url --room 1234567890/9876543210 --livestream`,
      `${prefix}play movie.mkv --copy --height 720`,
    ],
    "yt-dlp": [
      `${prefix}yt-dlp https://www.youtube.com/watch?v=dQw4w9WgXcQ`,
      `${prefix}yt-dlp https://twitch.tv/video --format "best[height<=720]"`,
      `${prefix}yt-dlp https://video.url --list-formats`,
    ],
    obs: [
      `${prefix}obs`,
      `${prefix}obs --port 1935 --protocol rtmp`,
      `${prefix}obs --protocol srt --room 123456/789012`,
    ],
    skip: [`${prefix}skip`],
    stop: [`${prefix}stop`],
    queue: [`${prefix}queue`],
    volume: [`${prefix}volume`, `${prefix}volume 0.5`, `${prefix}volume 1.2`],
    help: [`${prefix}help`, `${prefix}help play`, `${prefix}help --status`],
  };
  return examples[commandName] || [];
}

function formatUptime(uptimeSeconds: number): string {
  const days = Math.floor(uptimeSeconds / 86400);
  const hours = Math.floor((uptimeSeconds % 86400) / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = Math.floor(uptimeSeconds % 60);

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
