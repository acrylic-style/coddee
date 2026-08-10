import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type Client,
  type Message,
} from "discord.js";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import prism from "prism-media";
import { stripBotMention } from "../discordMessageUtils.js";
import type { Logger } from "../logger.js";
import type { CodexSessionManager } from "../sessionManager.js";
import {
  DiscordPcmToRealtimePcm,
  RealtimePcmToDiscordPcm,
} from "./pcmTransforms.js";
import { RealtimeTranscriptionSession } from "./realtimeTranscriptionSession.js";
import {
  VoiceConversationService,
  type VoiceConversationResult,
} from "./voiceConversationService.js";
import { VoicevoxClient, splitSpeechText } from "./voicevoxClient.js";
import { VoiceMemoryStore } from "./voiceMemoryStore.js";
import { shouldHandleVoiceTranscript } from "./wakeWord.js";
import {
  VoiceWriteApprovalStore,
  type VoiceWriteProposal,
} from "./writeApprovalStore.js";

const APPROVAL_PREFIX = "voice-codex-write";
const MAX_INPUT_AUDIO_BYTES = 24_000 * 2 * 60;
const MAX_TRANSCRIPT_LOG_LENGTH = 1_000;

interface GuildVoiceState {
  connection: VoiceConnection;
  player: AudioPlayer;
  voiceChannelId: string;
  controlChannelId: string;
  transcriptionSessions: Map<string, RealtimeTranscriptionSession>;
  activeSpeakers: Set<string>;
  playbackQueue: Buffer[];
  synthesisGeneration: number;
}

interface DiscordVoiceControllerOptions {
  client: Client;
  apiKey: string;
  realtimeSessionModel: string;
  transcriptionModel: string;
  conversationModel: string;
  voicevoxBaseUrl: string;
  voicevoxSpeakerId: number;
  allowedUserIds: Set<string>;
  readSessions: CodexSessionManager;
  writeSessions: CodexSessionManager;
  memoryStore: VoiceMemoryStore;
  logger: Logger;
}

export class DiscordVoiceController {
  private readonly guilds = new Map<string, GuildVoiceState>();
  private readonly approvals = new VoiceWriteApprovalStore();
  private readonly conversation: VoiceConversationService;
  private readonly voicevox: VoicevoxClient;

  constructor(private readonly options: DiscordVoiceControllerOptions) {
    this.conversation = new VoiceConversationService({
      apiKey: options.apiKey,
      model: options.conversationModel,
      logger: options.logger,
      memoryStore: options.memoryStore,
    });
    this.voicevox = new VoicevoxClient({
      baseUrl: options.voicevoxBaseUrl,
      speakerId: options.voicevoxSpeakerId,
    });
  }

  async join(message: Message): Promise<string> {
    if (!message.guild || !message.member) {
      return "ボイス接続はサーバー内でのみ利用できます。";
    }
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) {
      return "先に接続したいボイスチャンネルへお入りください。";
    }

    await this.leave(message.guild.id);
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    connection.subscribe(player);

    const state: GuildVoiceState = {
      connection,
      player,
      voiceChannelId: voiceChannel.id,
      controlChannelId: message.channelId,
      transcriptionSessions: new Map(),
      activeSpeakers: new Set(),
      playbackQueue: [],
      synthesisGeneration: 0,
    };
    this.guilds.set(message.guild.id, state);
    player.on(AudioPlayerStatus.Idle, () => this.playNext(state));
    player.on("error", (error) => {
      this.options.logger.warn("Discord voice playback failed", {
        guildId: message.guild?.id,
        error: error.message,
      });
      this.playNext(state);
    });
    connection.receiver.speaking.on("start", (userId) => {
      void this.captureUtterance(message.guild!.id, userId);
    });

    return [
      `${voiceChannel.name} に接続しました。`,
      "Bot とお一人だけなら、そのままお話しください。複数人の場合は「Codex」に続けてご用件をお話しください。",
      "検索結果と出典、書き込み操作の承認はこのテキストチャンネルへお出しします。",
    ].join("\n");
  }

  async leave(guildId: string): Promise<boolean> {
    const state = this.guilds.get(guildId);
    if (!state) {
      return false;
    }
    const conversationKey = this.conversationKey(guildId, state);
    try {
      await this.conversation.checkpoint(conversationKey);
    } catch (error) {
      this.options.logger.warn("Failed to checkpoint voice memory on leave", {
        guildId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.guilds.delete(guildId);
    state.synthesisGeneration += 1;
    for (const session of state.transcriptionSessions.values()) {
      session.close();
    }
    this.conversation.reset(conversationKey);
    state.player.stop(true);
    state.connection.destroy();
    return true;
  }

  async handleManagementCommand(
    message: Message,
    command: string,
  ): Promise<string | null> {
    const normalized = command.trim();
    const lower = normalized.toLowerCase();
    const isCharacterCommand =
      lower === "voice character" || lower.startsWith("voice character ");
    const isMemoryCommand =
      lower === "voice memory" || lower.startsWith("voice memory ");
    if (!isCharacterCommand && !isMemoryCommand) {
      return null;
    }
    if (!message.guild || !message.member?.voice.channelId) {
      return "この操作を行うボイスチャンネルへ先にお入りください。";
    }

    const key = this.memoryKey(
      message.guild.id,
      message.member.voice.channelId,
    );
    if (isCharacterCommand) {
      const value = normalized.slice("voice character".length).trim();
      if (!value) {
        const character = this.options.memoryStore.get(key).character;
        return character
          ? `現在のキャラ設定です。\n\n${character.slice(0, 1_800)}`
          : "このVCにはキャラ設定がありません。";
      }
      if (value.toLowerCase() === "clear") {
        await this.conversation.setCharacter(key, "");
        return "このVCのキャラ設定を削除しました。会話memoryは保持しています。";
      }
      if (value.length > 4_000) {
        return "キャラ設定は4,000文字以内にしてください。";
      }
      await this.conversation.setCharacter(key, value);
      return "このVCのキャラ設定を保存しました。次の応答から反映します。";
    }

    const action = normalized.slice("voice memory".length).trim().toLowerCase();
    if (!action) {
      const memory = this.options.memoryStore.get(key);
      const summary = memory.memorySummary || "記憶事項なし";
      return [
        "このVCの長期memoryです。",
        summary.slice(0, 1_700),
        `未要約の会話: ${memory.recentTurns.length}件`,
      ].join("\n\n");
    }
    if (action === "reset" || action === "forget") {
      await this.conversation.forgetMemory(key);
      return "このVCの会話memoryを削除しました。キャラ設定は保持しています。";
    }
    return "利用できる操作は `voice memory`、`voice memory reset`、`voice memory forget` です。";
  }

  async handleInteraction(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith(`${APPROVAL_PREFIX}:`)) {
      return false;
    }
    const [, action, proposalId] = interaction.customId.split(":");
    if (!proposalId || (action !== "approve" && action !== "deny")) {
      await interaction.reply({
        content: "承認情報を読み取れませんでした。",
        ephemeral: true,
      });
      return true;
    }
    const proposal = this.approvals.take(proposalId, interaction.user.id);
    if (!proposal) {
      await interaction.reply({
        content: "この承認依頼は期限切れか、別の方に向けたものです。",
        ephemeral: true,
      });
      return true;
    }
    await interaction.update({
      content:
        action === "approve"
          ? "✅ 書き込み操作を承認しました。Codex を実行しています…"
          : "🚫 書き込み操作を取り消しました。",
      components: [],
    });
    if (action === "approve") {
      void this.executeApprovedWrite(proposal, interaction);
    }
    return true;
  }

  async handleTextInput(message: Message): Promise<boolean> {
    if (!message.guild || !message.member || !this.options.client.user) {
      return false;
    }
    const state = this.guilds.get(message.guild.id);
    if (
      !state ||
      message.channelId !== state.voiceChannelId ||
      message.member.voice.channelId !== state.voiceChannelId ||
      !this.options.allowedUserIds.has(message.author.id) ||
      !(await this.isAddressedToBot(message))
    ) {
      return false;
    }

    const prompt = stripBotMention(
      message.content,
      this.options.client.user.id,
    ).trim();
    if (!prompt) {
      return false;
    }

    this.interruptPlayback(state);
    void this.handleVoicePrompt(
      message.guild.id,
      state,
      message.author.id,
      message.member.displayName || message.author.displayName,
      prompt,
      message.channelId,
    );
    return true;
  }

  private async captureUtterance(
    guildId: string,
    userId: string,
  ): Promise<void> {
    const state = this.guilds.get(guildId);
    if (
      !state ||
      !this.options.allowedUserIds.has(userId) ||
      state.activeSpeakers.has(userId)
    ) {
      return;
    }
    state.activeSpeakers.add(userId);
    const session = this.getTranscriptionSession(state, userId);
    void session.connect().catch((error) => {
      this.options.logger.warn("Failed to warm transcription session", {
        guildId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    let totalBytes = 0;
    const opusStream = state.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 500 },
    });
    const decoder = new prism.opus.Decoder({
      rate: 48_000,
      channels: 2,
      frameSize: 960,
    });
    const pcmStream = opusStream
      .pipe(decoder)
      .pipe(new DiscordPcmToRealtimePcm());
    let finalized = false;
    let failed = false;
    const finalize = (): void => {
      if (finalized) {
        return;
      }
      finalized = true;
      state.activeSpeakers.delete(userId);
      if (!failed && totalBytes > 0) {
        void session
          .commitAudio()
          .then((transcript) =>
            this.handleTranscript(guildId, userId, transcript),
          )
          .catch((error) => {
            this.options.logger.error("Failed to transcribe voice utterance", {
              guildId,
              userId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
    };

    pcmStream.on("data", (chunk: Buffer) => {
      if (totalBytes >= MAX_INPUT_AUDIO_BYTES) {
        return;
      }
      const accepted = chunk.subarray(
        0,
        Math.min(chunk.length, MAX_INPUT_AUDIO_BYTES - totalBytes),
      );
      totalBytes += accepted.length;
      session.appendAudio(accepted);
    });
    const logDecodeError = (error: Error): void => {
      failed = true;
      this.options.logger.warn("Failed to decode Discord voice input", {
        guildId,
        userId,
        error: error.message,
      });
      finalize();
    };
    opusStream.once("error", logDecodeError);
    decoder.once("error", logDecodeError);
    pcmStream.once("error", logDecodeError);
    pcmStream.once("end", finalize);
    pcmStream.once("close", finalize);
  }

  private async handleTranscript(
    guildId: string,
    userId: string,
    transcript: string,
  ): Promise<void> {
    const state = this.guilds.get(guildId);
    if (!state) {
      return;
    }
    const normalizedTranscript = transcript.trim();
    if (!normalizedTranscript) {
      this.options.logger.debug("Voice transcription completed", {
        guildId,
        userId,
        transcript: "",
        empty: true,
      });
      return;
    }
    const humanCount = await this.getHumanCount(state);
    const wakeWord = shouldHandleVoiceTranscript(
      normalizedTranscript,
      humanCount,
    );
    this.options.logger.debug("Voice transcription completed", {
      guildId,
      userId,
      humanCount,
      transcript: normalizedTranscript.slice(0, MAX_TRANSCRIPT_LOG_LENGTH),
      transcriptTruncated:
        normalizedTranscript.length > MAX_TRANSCRIPT_LOG_LENGTH,
      wakeWordMatched: wakeWord.matched,
      promptLength: wakeWord.prompt.length,
    });
    if (!wakeWord.matched || !wakeWord.prompt) {
      this.options.logger.debug("Ignored voice utterance without wake word", {
        guildId,
        userId,
        humanCount,
      });
      return;
    }

    this.interruptPlayback(state);
    const user = await this.options.client.users.fetch(userId);
    await this.handleVoicePrompt(
      guildId,
      state,
      userId,
      user.displayName || user.username,
      wakeWord.prompt,
      state.controlChannelId,
    );
  }

  private async handleVoicePrompt(
    guildId: string,
    state: GuildVoiceState,
    userId: string,
    speakerName: string,
    prompt: string,
    responseChannelId: string,
  ): Promise<void> {
    try {
      const sessionKey = `voice:${guildId}:${state.voiceChannelId}`;
      const result = await this.conversation.respond(
        this.conversationKey(guildId, state),
        speakerName,
        prompt,
        {
          read: (prompt) => this.runReadOnly(sessionKey, prompt),
          requestWrite: (prompt, summary) =>
            this.requestWriteApproval(
              guildId,
              responseChannelId,
              userId,
              sessionKey,
              prompt,
              summary,
            ),
        },
      );
      await this.publishResult(responseChannelId, result);
      void this.speak(state, result.text);
    } catch (error) {
      this.options.logger.error("Failed to answer voice utterance", {
        guildId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.publishText(
        responseChannelId,
        "音声リクエストの処理中にエラーが発生しました。",
      );
    }
  }

  private async isAddressedToBot(message: Message): Promise<boolean> {
    const botUserId = this.options.client.user?.id;
    if (!botUserId) {
      return false;
    }
    if (message.mentions.users.has(botUserId)) {
      return true;
    }
    if (!message.reference?.messageId) {
      return false;
    }
    try {
      const referenced = await message.fetchReference();
      return referenced.author.id === botUserId;
    } catch (error) {
      this.options.logger.debug("Failed to inspect replied voice message", {
        guildId: message.guildId,
        channelId: message.channelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private getTranscriptionSession(
    state: GuildVoiceState,
    userId: string,
  ): RealtimeTranscriptionSession {
    const existing = state.transcriptionSessions.get(userId);
    if (existing) {
      return existing;
    }
    const session = new RealtimeTranscriptionSession({
      apiKey: this.options.apiKey,
      sessionModel: this.options.realtimeSessionModel,
      transcriptionModel: this.options.transcriptionModel,
      safetyIdentifier: `discord-${userId}`,
      logger: this.options.logger,
    });
    state.transcriptionSessions.set(userId, session);
    return session;
  }

  private async getHumanCount(state: GuildVoiceState): Promise<number> {
    const channel = await this.options.client.channels.fetch(
      state.voiceChannelId,
    );
    if (!channel?.isVoiceBased()) {
      return 0;
    }
    return channel.members.filter((member) => !member.user.bot).size;
  }

  private async runReadOnly(
    sessionKey: string,
    prompt: string,
  ): Promise<{ status: string; result: string }> {
    const result = await this.options.readSessions.enqueueTurn(sessionKey, {
      messageId: randomUUID(),
      channelId: sessionKey,
      input: [
        "これは読み取り専用モードです。",
        "ファイル変更、状態変更、外部サービスへの書き込み、副作用のあるコマンドは実行しないでください。",
        "必要なら読み取り専用の調査だけを行い、変更が必要な場合は何を変更すべきか説明するだけにしてください。",
        "ネットワークアクセスは使用しないでください。",
        "",
        prompt,
      ].join("\n"),
      requestedAt: Date.now(),
    });
    return { status: "completed_read_only", result: result.text };
  }

  private async requestWriteApproval(
    guildId: string,
    channelId: string,
    userId: string,
    sessionKey: string,
    prompt: string,
    summary: string,
  ): Promise<{ status: string; approvalId: string }> {
    if (!prompt.trim()) {
      throw new Error("Codex task is empty");
    }
    const proposal = this.approvals.create({
      guildId,
      channelId,
      userId,
      sessionKey,
      prompt: prompt.trim(),
    });
    const channel = await this.options.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error("Approval channel is not sendable");
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${APPROVAL_PREFIX}:approve:${proposal.id}`)
        .setLabel("実行を承認")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${APPROVAL_PREFIX}:deny:${proposal.id}`)
        .setLabel("取り消す")
        .setStyle(ButtonStyle.Secondary),
    );
    await channel.send({
      content: [
        `<@${userId}> 書き込み操作の確認です。`,
        (summary.trim() || prompt.trim()).slice(0, 1_200),
        "内容をご確認のうえ、5分以内に選択してください。",
      ].join("\n\n"),
      components: [row],
      allowedMentions: { users: [userId] },
    });
    return { status: "awaiting_user_approval", approvalId: proposal.id };
  }

  private async executeApprovedWrite(
    proposal: VoiceWriteProposal,
    interaction: ButtonInteraction,
  ): Promise<void> {
    try {
      const result = await this.options.writeSessions.enqueueTurn(
        `write:${proposal.sessionKey}`,
        {
          messageId: randomUUID(),
          channelId: proposal.channelId,
          input: [
            "Discord 上でユーザーがこの書き込み操作を明示的に承認しました。",
            "承認された依頼の範囲内で実装し、必要な検証を行ってください。",
            "追加の書き込みや依頼範囲の拡大が必要なら実行せず、その旨を回答してください。",
            "",
            proposal.prompt,
          ].join("\n"),
          requestedAt: Date.now(),
        },
      );
      await interaction.followUp({
        content: result.text.slice(0, 2_000) || "Codex の実行が完了しました。",
        allowedMentions: { parse: [] },
      });
      const state = this.guilds.get(proposal.guildId);
      if (state) {
        try {
          await this.conversation.recordExternalResult(
            this.conversationKey(proposal.guildId, state),
            result.text || "Codex の実行が完了しました。",
          );
        } catch (error) {
          this.options.logger.warn(
            "Failed to persist approved Codex result in voice memory",
            {
              guildId: proposal.guildId,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
        void this.speak(state, result.text || "Codex の実行が完了しました。");
      }
    } catch (error) {
      this.options.logger.error("Approved voice Codex write failed", {
        guildId: proposal.guildId,
        userId: proposal.userId,
        error: error instanceof Error ? error.message : String(error),
      });
      await interaction.followUp({
        content: "承認された Codex 操作の実行中にエラーが発生しました。",
        allowedMentions: { parse: [] },
      });
    }
  }

  private async publishResult(
    channelId: string,
    result: VoiceConversationResult,
  ): Promise<void> {
    if (result.sources.length === 0) {
      return;
    }
    const sources = result.sources
      .slice(0, 8)
      .map((source, index) => `${index + 1}. [${source.title}](${source.url})`)
      .join("\n");
    await this.publishText(
      channelId,
      `${result.text.slice(0, 1_400)}\n\n出典:\n${sources}`.slice(0, 2_000),
    );
  }

  private async publishText(channelId: string, content: string): Promise<void> {
    const channel = await this.options.client.channels.fetch(channelId);
    if (channel?.isTextBased() && "send" in channel) {
      await channel.send({ content, allowedMentions: { parse: [] } });
    }
  }

  private async speak(state: GuildVoiceState, text: string): Promise<void> {
    const generation = ++state.synthesisGeneration;
    state.playbackQueue.length = 0;
    state.player.stop(true);
    try {
      const segments = splitSpeechText(text);
      for (const [segmentIndex, segment] of segments.entries()) {
        this.options.logger.debug("Sending text to VOICEVOX", {
          segmentIndex,
          segmentCount: segments.length,
          text: segment,
          length: segment.length,
        });
        const pcm = await this.voicevox.synthesize(segment);
        if (state.synthesisGeneration !== generation) {
          return;
        }
        state.playbackQueue.push(pcm);
        this.playNext(state);
      }
    } catch (error) {
      this.options.logger.warn("VOICEVOX speech synthesis failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.publishText(
        state.controlChannelId,
        `VOICEVOX で読み上げられませんでした。\n\n${text.slice(0, 1_800)}`,
      );
    }
  }

  private interruptPlayback(state: GuildVoiceState): void {
    state.synthesisGeneration += 1;
    state.playbackQueue.length = 0;
    state.player.stop(true);
  }

  private playNext(state: GuildVoiceState): void {
    if (state.player.state.status !== AudioPlayerStatus.Idle) {
      return;
    }
    const pcm = state.playbackQueue.shift();
    if (!pcm) {
      return;
    }
    const source = Readable.from([pcm]);
    const upsample = new RealtimePcmToDiscordPcm();
    const encoder = new prism.opus.Encoder({
      rate: 48_000,
      channels: 2,
      frameSize: 960,
    });
    source.pipe(upsample).pipe(encoder);
    state.player.play(
      createAudioResource(encoder, { inputType: StreamType.Opus }),
    );
  }

  private conversationKey(guildId: string, state: GuildVoiceState): string {
    return this.memoryKey(guildId, state.voiceChannelId);
  }

  private memoryKey(guildId: string, voiceChannelId: string): string {
    return `voice-conversation:${guildId}:${voiceChannelId}`;
  }
}
