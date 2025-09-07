import { Command, Option } from "@commander-js/extra-typings";
import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import {
  prepareStream,
  playStream,
  Streamer,
  Encoders,
  type Controller,
} from "@dank074/discord-video-stream";
import * as Ingestor from "./input/ffmpegIngest.js";
import * as ytdlp from "./input/yt-dlp.js";
import { createCommand } from "../index.js";
import { getLogger } from "../../utils/logger.js";
import { MessageFlags, StageChannel } from "discord.js-selfbot-v13";

import type { Module } from "../index.js";
import type { Message } from "discord.js-selfbot-v13";
import type { Bot } from "../../bot.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

async function joinRoomIfNeeded(
  streamer: Streamer,
  message: Message,
  optionalRoom?: string,
) {
  let guildId: string;
  let targetChannelId: string;
  if (optionalRoom) {
    [guildId, targetChannelId] = optionalRoom.split("/");
    if (!guildId) {
      message.reply("Guild ID is empty");
      return false;
    }
    if (!targetChannelId) {
      message.reply("Channel ID is empty");
      return false;
    }
  } else {
    guildId = message.guildId ?? "";
    const channelIdNullable = message.author.voice?.channel?.id;
    if (!channelIdNullable) {
      message.reply("Please join a voice channel first!");
      return false;
    }
    targetChannelId = channelIdNullable;
  }
  if (
    !streamer.voiceConnection ||
    streamer.voiceConnection.guildId !== guildId ||
    streamer.voiceConnection.channelId !== targetChannelId
  )
    await streamer.joinVoice(guildId, targetChannelId);

  if (streamer.client.user?.voice?.channel instanceof StageChannel)
    await streamer.client.user.voice.setSuppressed(false);
  return true;
}

async function forceCleanupSockets() {
  try {
    // Kill only discord-video-streamer related ffmpeg processes
    await execAsync(
      "pgrep -f 'discord-video-streamer' | xargs kill -9 || true",
    ).catch(() => {});
    await execAsync("pgrep -f 'discord.*stream' | xargs kill -9 || true").catch(
      () => {},
    );

    // Kill any processes specifically listening on port 42069 (ZMQ port)
    await execAsync("lsof -ti:42069 | xargs kill -9 || true").catch(() => {});
    await execAsync(
      "ss -tlnp | grep :42069 | grep -o 'pid=[0-9]*' | cut -d'=' -f2 | xargs kill -9 || true",
    ).catch(() => {});

    // Kill processes specifically related to discord-video-streamer with ZMQ
    await execAsync(
      "pgrep -f 'discord-video-streamer.*zmq' | xargs kill -9 || true",
    ).catch(() => {});
    await execAsync("pgrep -f 'stream.*zmq' | xargs kill -9 || true").catch(
      () => {},
    );

    // Wait for cleanup
    await new Promise((resolve) => setTimeout(resolve, 2000));
    getLogger().info("Performed targeted socket cleanup");
  } catch (error) {
    const err = error as Error;
    getLogger().warn("Socket cleanup warning", { error: err.message });
  }
}

async function isZmqPortAvailable(): Promise<boolean> {
  try {
    // Check if port 42069 is in use
    const { stdout } = await execAsync(
      "lsof -i :42069 2>/dev/null || ss -tlnp | grep :42069 2>/dev/null",
    );
    return stdout.trim() === "";
  } catch (error) {
    // If commands fail, assume port is available (or not critical)
    getLogger().debug("Port check failed, assuming available", {
      error: (error as Error).message,
    });
    return true;
  }
}

type StreamItem = {
  controller: Controller;
  promise: Promise<unknown>;
};
type QueueItem = {
  info: string;
  stream: (abort: AbortController) => Promise<StreamItem>;
};

class Playlist {
  private _items: QueueItem[] = [];
  private _current?: StreamItem;
  private _currentInfo?: string;
  private _abort?: AbortController;
  private _processing = false;

  private async processQueue() {
    this._processing = true;
    let next: QueueItem | undefined;
    next = this._items.shift();
    while (next) {
      try {
        this._abort?.abort();
        // Wait for previous stream resources to cleanup before starting new one
        if (this._abort) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
        this._abort = new AbortController();
        this._currentInfo = next.info;

        // Retry stream creation if socket conflicts occur
        let retries = 3;
        let streamResult: StreamItem | undefined;
        while (retries > 0) {
          try {
            if (!this._abort) {
              throw new Error("Abort controller not initialized");
            }
            streamResult = await next.stream(this._abort);
            break;
          } catch (error) {
            const err = error as Error;
            if (
              err.message?.includes("Address already in use") &&
              retries > 1
            ) {
              getLogger().warn(
                `Socket conflict detected, performing aggressive cleanup... (${retries - 1} retries left)`,
                { retries: retries - 1 },
              );
              await forceCleanupSockets();
              await new Promise((resolve) => setTimeout(resolve, 3000));
              retries--;
            } else {
              throw error;
            }
          }
        }

        if (!streamResult) {
          throw new Error("Failed to create stream after retries");
        }

        this._current = streamResult;
        await this._current.promise;
      } catch (error) {
        getLogger().logError("Stream playback error", {
          error: (error as Error).message,
          stack: (error as Error).stack,
          stream: next?.info,
        });
      }
      next = this._items.shift();
    }
    this._processing = false;
    this._current = undefined;
    this._currentInfo = undefined;
  }
  async queue(queueItem: QueueItem, playNow = false) {
    if (playNow) {
      // Stop current item and add to front of queue
      this._abort?.abort();
      // Wait for sockets (like ZMQ) to properly close before continuing
      if (this._abort) {
        await forceCleanupSockets();
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Check if ZMQ port is available before retrying
        let portAvailable = await isZmqPortAvailable();
        let waitCount = 0;
        while (!portAvailable && waitCount < 5) {
          getLogger().warn(
            "ZMQ port still in use, waiting longer for cleanup...",
            { waitCount: waitCount + 1 },
          );
          await new Promise((resolve) => setTimeout(resolve, 3000));
          portAvailable = await isZmqPortAvailable();
          waitCount++;
        }
        if (!portAvailable) {
          getLogger().error(
            "ZMQ port still unavailable after extended wait, proceeding anyway",
          );
        }
      }
      this._items.unshift(queueItem);
    } else {
      this._items.push(queueItem);
    }
    if (!this._processing) this.processQueue();
  }
  async skip() {
    this._abort?.abort();
    // Perform aggressive cleanup to ensure sockets are freed
    await forceCleanupSockets();
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  async stop() {
    this._items = [];
    await this.skip();
  }
  get items() {
    return this._items;
  }
  get current() {
    return this._current;
  }
  get processing() {
    return this._processing;
  }
  get hasActiveStream() {
    return this._processing && this._current !== undefined;
  }
  get currentInfo() {
    return this._currentInfo;
  }
}

function errorHandler(err: Error, bot: Bot, message: Message) {
  if (err.name === "AbortError") return;
  getLogger().logError(
    "Stream error occurred",
    getLogger().createMessageContext(message, { error: err.message }),
  );
  message.reply(`Oops, something bad happened
\`\`\`
${err.message}
\`\`\``);
}

function addCommonStreamOptions<
  Args extends unknown[],
  Opts extends Record<string, unknown>,
>(command: Command<Args, Opts>) {
  return command
    .option(
      "--room <id>",
      "The room ID, specified as <guildId>/<channelId>. If not specified, use the current room of the caller",
    )
    .option("--preview", "Enable stream preview");
}

export default {
  name: "stream",
  register(bot) {
    const streamer = new Streamer(bot.client, {
      forceChacha20Encryption: true,
    });
    const playlist = new Playlist();

    // Expose streaming state for health checks
    const botWithStreamingState = bot as typeof bot & {
      streamingState: {
        isStreaming: boolean;
        isProcessing: boolean;
        queueLength: number;
        currentStream: string | null;
        voiceConnection: {
          guildId: string | null;
          channelId: string;
          ready: boolean;
        } | null;
      };
    };
    botWithStreamingState.streamingState = {
      get isStreaming() {
        return playlist.hasActiveStream;
      },
      get isProcessing() {
        return playlist.processing;
      },
      get queueLength() {
        return playlist.items.length;
      },
      get currentStream() {
        return playlist.currentInfo || null;
      },
      get voiceConnection() {
        return streamer.voiceConnection
          ? {
              guildId: streamer.voiceConnection.guildId,
              channelId: streamer.voiceConnection.channelId,
              ready:
                typeof streamer.voiceConnection.ready === "function"
                  ? true
                  : streamer.voiceConnection.ready,
            }
          : null;
      },
    };
    let encoder:
      | ReturnType<typeof Encoders.software>
      | ReturnType<typeof Encoders.nvenc>;
    switch (bot.config.encoder.name) {
      case "software":
        encoder = Encoders.software({
          x264: {
            preset: bot.config.encoder.x264_preset,
          },
          x265: {
            preset: bot.config.encoder.x265_preset,
          },
        });
        break;
      case "nvenc":
        encoder = Encoders.nvenc({
          preset: bot.config.encoder.preset,
        });
        break;
    }
    const encoderSettings = {
      encoder,
      bitrateVideo: bot.config.bitrate,
      bitrateVideoMax: bot.config.bitrate_max,
    };
    return [
      createCommand(
        addCommonStreamOptions(
          new Command("play")
            .description("Play a video file or link")
            .argument("<url...>", "The urls to play")
            .option("--copy", "Copy the stream directly instead of re-encoding")
            .option("--livestream", "Specify if the stream is a livestream")

            .option("--now", "Play immediately, skipping any current playback")
            .option(
              "--height <height>",
              "Transcode the video to this height. Specify -1 for auto height",
              Number.parseInt,
              bot.config.height,
            ),
        ),
        async (message, args, opts) => {
          if (!(await joinRoomIfNeeded(streamer, message, opts.room))) return;
          let added = 0;
          for (const url of args[0]) {
            await playlist.queue(
              {
                info: url,
                stream: async (abort) => {
                  getLogger().logStream(
                    "Starting playback",
                    { url },
                    getLogger().createMessageContext(message),
                  );
                  message.channel.send({
                    content: `Now playing \`${url}\``,
                    flags: MessageFlags.FLAGS.SUPPRESS_NOTIFICATIONS,
                  });
                  try {
                    const { command, output, controller } = prepareStream(
                      url,
                      {
                        noTranscoding: !!opts.copy,
                        ...encoderSettings,
                        height: opts.height === -1 ? undefined : opts.height,
                        customFfmpegFlags: [
                          "-reconnect",
                          "1",
                          "-reconnect_at_eof",
                          "1",
                          "-reconnect_streamed",
                          "1",
                          "-reconnect_delay_max",
                          "5",
                          "-timeout",
                          "10000000",
                          "-rw_timeout",
                          "10000000",
                        ],
                      },
                      abort.signal,
                    );
                    let zmqErrorDetected = false;

                    command.on("stderr", (line: string) => {
                      getLogger().debug("FFmpeg stderr", { line, url });
                      // Check for socket binding errors
                      if (
                        line.includes("Could not bind ZMQ socket") &&
                        line.includes("Address already in use")
                      ) {
                        getLogger().error(
                          "ZMQ socket binding failed - port conflict detected",
                          { url, line },
                        );
                        getLogger().info(
                          "Aborting stream due to ZMQ conflict, retry will be attempted",
                          { url },
                        );
                        zmqErrorDetected = true;
                        // Abort the ffmpeg process immediately
                        abort.abort();
                      }
                    });

                    const basePromise = playStream(
                      output,
                      streamer,
                      {
                        readrateInitialBurst: opts.livestream ? 10 : undefined,
                        streamPreview: opts.preview,
                      },
                      abort.signal,
                    );

                    // Wrap the promise to handle ZMQ errors
                    const streamResultPromise = basePromise.catch((error) => {
                      if (zmqErrorDetected) {
                        getLogger().warn(
                          "Converting ZMQ conflict to retriable error",
                          { url },
                        );
                        throw new Error("Address already in use");
                      }
                      throw error;
                    });

                    return { controller, promise: streamResultPromise };
                  } catch (e) {
                    const error = e as Error;
                    if (
                      error.message?.includes("Address already in use") ||
                      error.message?.includes("Could not bind ZMQ socket")
                    ) {
                      getLogger().error(`Socket conflict error for ${url}`, {
                        url,
                        error: error.message,
                      });
                      throw new Error(
                        `Socket conflict - please try again: ${error.message}`,
                      );
                    }
                    errorHandler(error, bot, message);
                    throw e;
                  }
                },
              },
              opts.now,
            );
            added++;
          }
          const queueMessage = opts.now
            ? `Playing ${added} video${added === 1 ? "" : "s"} now`
            : `Added ${added} video${added === 1 ? "" : "s"} to the queue`;
          message.reply(queueMessage);
        },
      ),

      createCommand(
        addCommonStreamOptions(
          new Command("obs")
            .description("Starts an OBS ingest server for livestreaming")
            .option(
              "-p, --port <port>",
              "Port to use, leave blank for a random port",
              Number.parseInt,
            )
            .addOption(
              new Option("--protocol <prot>", "Stream protocol to use")
                .choices(["rtmp", "srt", "rist"])
                .default("srt"),
            ),
        ),
        async (message, args, opts) => {
          if (!(await joinRoomIfNeeded(streamer, message, opts.room))) return;
          await playlist.queue({
            info: "OBS stream",
            stream: async (abort) => {
              getLogger().logStream(
                "Starting OBS playback",
                {},
                getLogger().createMessageContext(message),
              );
              message.channel.send({
                content: "Now playing OBS stream",
                flags: MessageFlags.FLAGS.SUPPRESS_NOTIFICATIONS,
              });
              try {
                const ingestor = {
                  srt: Ingestor.ingestSrt,
                  rtmp: Ingestor.ingestRtmp,
                  rist: Ingestor.ingestRist,
                } as const;
                const { command, output, host } = ingestor[opts.protocol](
                  opts.port,
                  abort.signal,
                );

                let zmqErrorDetected = false;

                command.ffmpeg.on("stderr", (line) => {
                  getLogger().debug("OBS FFmpeg stderr", { line });
                  // Check for socket binding errors in OBS streams
                  if (
                    line.includes("Could not bind ZMQ socket") &&
                    line.includes("Address already in use")
                  ) {
                    getLogger().error(
                      "ZMQ socket binding failed in OBS stream - port conflict detected",
                      { line },
                    );
                    getLogger().info(
                      "Aborting OBS stream due to ZMQ conflict, retry will be attempted",
                    );
                    zmqErrorDetected = true;
                    // Abort the ffmpeg process immediately
                    abort.abort();
                  }
                });

                message.reply(`Please connect your OBS to \`${host}\``);
                output.once("data", () => {
                  getLogger().debug(
                    "Media stream found. Starting playback...",
                    getLogger().createMessageContext(message),
                  );
                });
                const basePromise = playStream(
                  output,
                  streamer,
                  {
                    readrateInitialBurst: 10,
                    streamPreview: opts.preview,
                  },
                  abort.signal,
                );

                // Wrap the promise to handle ZMQ errors
                const promise = basePromise.catch((error) => {
                  if (zmqErrorDetected) {
                    getLogger().warn(
                      "Converting OBS ZMQ conflict to retriable error",
                    );
                    throw new Error("Address already in use");
                  }
                  throw error;
                });
                const controller = {
                  get volume() {
                    return 1;
                  },
                  async setVolume() {
                    throw new Error(
                      "Setting volume for OBS streams isn't allowed at the moment",
                    );
                  },
                };
                return { controller, promise };
              } catch (e) {
                errorHandler(e as Error, bot, message);
                throw e;
              }
            },
          });
          message.reply("Added OBS stream to the queue");
        },
      ),

      createCommand(
        addCommonStreamOptions(
          new Command("yt-dlp")
            .description("Play a video using yt-dlp")
            .argument("<url>", "The url to play")
            .option("--list-formats", "List all the formats in this video")
            .option("--format <format>", "The format to use.", "bv*+ba/b")
            .option(
              "--height <height>",
              "Transcode the video to this height.",
              Number.parseInt,
              bot.config.height,
            ),
        ),
        async (message, args, opts) => {
          const url = args[0];
          if (opts.listFormats) {
            const formats = await ytdlp.getFormats(url);
            let reply = "";
            reply += `Formats for URL \`${url}\`\n`;
            for (const format of formats) {
              reply += `- \`${format.format_id}\`: ext ${format.ext}, res ${format.resolution}, fps ${format.fps}\n`;
            }
            message.reply(reply);
            return;
          }
          if (!(await joinRoomIfNeeded(streamer, message, opts.room))) return;

          await playlist.queue({
            info: args[0],
            stream: async (abort) => {
              getLogger().logStream(
                "Starting yt-dlp playback",
                { url: args[0] },
                getLogger().createMessageContext(message),
              );
              message.channel.send({
                content: `Now playing \`${args[0]}\``,
                flags: MessageFlags.FLAGS.SUPPRESS_NOTIFICATIONS,
              });
              try {
                let format = opts.format;
                if (opts.height !== -1 && opts.height > 0) {
                  format = format.replace(
                    /bv\*/g,
                    `bv*[height<=${opts.height}]`,
                  );
                }
                const { command, output, controller } = ytdlp.ytdlp(
                  url,
                  format,
                  {
                    ...encoderSettings,
                    height: opts.height === -1 ? undefined : opts.height,
                  },
                  abort.signal,
                );
                let zmqErrorDetected = false;

                command.ffmpeg.on("stderr", (line) => {
                  getLogger().debug("yt-dlp FFmpeg stderr", {
                    line,
                    url: args[0],
                  });
                  // Check for socket binding errors in yt-dlp streams
                  if (
                    line.includes("Could not bind ZMQ socket") &&
                    line.includes("Address already in use")
                  ) {
                    getLogger().error(
                      "ZMQ socket binding failed in yt-dlp stream - port conflict detected",
                      { line, url: args[0] },
                    );
                    getLogger().info(
                      "Aborting yt-dlp stream due to ZMQ conflict, retry will be attempted",
                      { url: args[0] },
                    );
                    zmqErrorDetected = true;
                    // Abort the ffmpeg process immediately
                    abort.abort();
                  }
                });
                const basePromise = playStream(
                  output,
                  streamer,
                  {
                    streamPreview: opts.preview,
                  },
                  abort.signal,
                );

                // Wrap the promise to handle ZMQ errors
                const promise = basePromise.catch((error) => {
                  if (zmqErrorDetected) {
                    getLogger().warn(
                      "Converting yt-dlp ZMQ conflict to retriable error",
                      { url: args[0] },
                    );
                    throw new Error("Address already in use");
                  }
                  throw error;
                });

                return { controller, promise };
              } catch (e) {
                errorHandler(e as Error, bot, message);
                throw e;
              }
            },
          });
          message.reply(`Added \`${args[0]}\` to the queue`);
        },
      ),

      createCommand(
        new Command("volume")
          .description("Adjust the stream volume, or get the current volume")
          .argument("[value]", "The new stream volume (must be non-negative)"),
        async (msg, args) => {
          if (!playlist.current) {
            msg.reply("No stream is currently running");
            return;
          }
          const { controller } = playlist.current;
          if (!args[0]) {
            msg.reply(`Current volume: ${controller.volume}`);
            return;
          }
          const volume = Number.parseFloat(args[0]);
          if (!Number.isFinite(volume)) {
            msg.reply("Invalid number");
            return;
          }
          try {
            if (await controller.setVolume(volume))
              msg.reply("Set volume successful");
            else msg.reply("Set volume unsuccessful");
          } catch (e) {
            msg.reply(`Set volume unsuccessful: \`${(e as Error).message}\``);
          }
        },
      ),

      createCommand(
        new Command("queue").description("View the queue"),
        async (message) => {
          if (!playlist.items.length)
            return message.reply("There are no items in the queue");
          const { length } = playlist.items;
          let content = `There are ${length} ${length === 1 ? "item" : "items"} in the queue`;
          let i = 1;
          for (const item of playlist.items)
            content += `\n${i++}. \`${item.info}\``;
          return message.reply(content);
        },
      ),
      createCommand(new Command("skip"), async () => {
        await playlist.skip();
      }),

      createCommand(new Command("stop"), async () => {
        await playlist.stop();
      }),

      createCommand(new Command("disconnect"), async () => {
        await playlist.stop();
        streamer.leaveVoice();
      }),
    ];
  },
} satisfies Module;
