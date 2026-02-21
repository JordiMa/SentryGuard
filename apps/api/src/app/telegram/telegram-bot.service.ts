import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Telegraf, Context } from 'telegraf';
import type { Request, Response } from 'express';
import i18n from '../../i18n';
import {
  TelegramConfig,
  TelegramLinkStatus,
} from '../../entities/telegram-config.entity';
import { Vehicle } from '../../entities/vehicle.entity';
import { UserLanguageService } from '../user/user-language.service';

interface TelegramKeyboard {
  inline_keyboard?: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
  keyboard?: Array<Array<{ text: string }>>;
  one_time_keyboard?: boolean;
  resize_keyboard?: boolean;
}

interface TelegramMessageOptions {
  keyboard?: TelegramKeyboard;
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2';
}

@Injectable()
export class TelegramBotService implements OnModuleInit {
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: Telegraf<Context> | null = null;
  private readonly botToken = process.env.TELEGRAM_BOT_TOKEN;
  private readonly webhookBaseUrl = process.env.TELEGRAM_WEBHOOK_BASE;
  private readonly webhookSecretPath =
    process.env.TELEGRAM_WEBHOOK_SECRET_PATH;
  private readonly webhookSecretToken =
    process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN || undefined;
  private readonly mode = process.env.TELEGRAM_MODE || 'webhook';
  private webhookCallback:
    | ReturnType<Telegraf<Context>['webhookCallback']>
    | null = null;

  constructor(
    @InjectRepository(TelegramConfig)
    private readonly telegramConfigRepository: Repository<TelegramConfig>,
    @InjectRepository(Vehicle)
    private readonly vehicleRepository: Repository<Vehicle>,
    private readonly userLanguageService: UserLanguageService
  ) {}

  async onModuleInit() {
    if (!this.botToken) {
      this.logger.warn(
        '⚠️ TELEGRAM_BOT_TOKEN not defined, Telegram bot disabled'
      );
      return;
    }

    try {
      this.bot = new Telegraf(this.botToken);

      this.setupBotCommands();

      if (this.mode === 'polling') {
        await this.setupPollingMode();
      } else {
        await this.setupWebhookMode();
      }

      process.once('SIGINT', () => this.bot?.stop('SIGINT'));
      process.once('SIGTERM', () => this.bot?.stop('SIGTERM'));
    } catch (error) {
      this.logger.error('❌ Telegram bot initialization error:', error);
    }
  }

  async getBotUsername(): Promise<string | null> {
    if (!this.bot) {
      return process.env.TELEGRAM_BOT_USERNAME || null;
    }

    try {
      const botProfile = await this.bot.telegram.getMe();
      return botProfile.username || null;
    } catch (error) {
      this.logger.error(
        '❌ Error while trying to get bot username:',
        error
      );
      return process.env.TELEGRAM_BOT_USERNAME || null;
    }
  }

  getWebhookSecretPath(): string {
    return (this.webhookSecretPath || '').replace(/^\//, '');
  }

  getWebhookSecretToken(): string | undefined {
    return this.webhookSecretToken;
  }

  async handleUpdate(req: Request, res: Response): Promise<void> {
    if (!this.webhookCallback) {
      this.logger.warn('⚠️ Webhook not initialized');
      res.status(503).send('Webhook not configured');
      return;
    }

    return this.webhookCallback(req, res);
  }

  async sendMessageToUser(
    userId: string,
    message: string,
    options?: TelegramMessageOptions
  ): Promise<boolean> {
    if (!this.bot) {
      this.logger.warn('⚠️ Telegram bot not initialized');
      return false;
    }

    const config = await this.telegramConfigRepository.findOne({
      where: { userId, status: TelegramLinkStatus.LINKED },
    });

    if (!config || !config.chat_id) {
      this.logger.warn(
        `⚠️ No chat_id found for user: ${userId}`
      );
      return false;
    }

    if (config.muted_until && new Date() < config.muted_until) {
      this.logger.log(`🔕 Notifications muted for user ${userId} until ${config.muted_until}`);
      return false;
    }

    const telegramOptions = this.buildTelegramOptions(options);
    await this.bot.telegram.sendMessage(config.chat_id, message, telegramOptions);

    this.logger.log(`📱 Message sent to user ${userId} (chat_id: ${config.chat_id})`);
    return true;
  }

  private buildTelegramOptions(options?: TelegramMessageOptions): Record<string, unknown> {
    const telegramOptions: Record<string, unknown> = {
      parse_mode: options?.parse_mode || 'HTML',
    };

    if (options?.keyboard?.inline_keyboard) {
      telegramOptions.reply_markup = {
        inline_keyboard: options.keyboard.inline_keyboard,
      };
    } else if (options?.keyboard?.keyboard) {
      telegramOptions.reply_markup = {
        keyboard: options.keyboard.keyboard,
        one_time_keyboard: options.keyboard.one_time_keyboard,
        resize_keyboard: options.keyboard.resize_keyboard,
      };
    }

    return telegramOptions;
  }

  private async safeReply(
    ctx: Context,
    message: string,
    options?: TelegramMessageOptions
  ): Promise<void> {
    try {
      const telegramOptions = this.buildTelegramOptions(options);
      await ctx.reply(message, Object.keys(telegramOptions).length > 1 ? telegramOptions : undefined);
    } catch (error) {
      this.logger.warn(
        `⚠️ Could not send message to user (possibly blocked the bot): ${error}`,
        error
      );
    }
  }

  private setupBotCommands() {
    if (!this.bot) return;

    this.bot.start(async (ctx) => {
      const args = ctx.message.text.split(' ');

      if (args.length > 1) {
        const linkToken = args[1];
        await this.handleLinkToken(ctx, linkToken);
      } else {
        await this.handleStartWithoutToken(ctx);
      }
    });

    this.bot.hears(
      [i18n.t('menuButtonStatus', { lng: 'en' }), i18n.t('menuButtonStatus', { lng: 'fr' })],
      async (ctx) => {
        await this.handleStatusButton(ctx);
      }
    );

    this.bot.hears(
      [
        i18n.t('menuButtonMute', { lng: 'en' }),
        i18n.t('menuButtonMute', { lng: 'fr' }),
        i18n.t('menuButtonMuteActive', { lng: 'en' }),
        i18n.t('menuButtonMuteActive', { lng: 'fr' }),
      ],
      async (ctx) => {
        await this.handleMuteButton(ctx);
      }
    );

    this.bot.action(/^mute:(\d+)$/, async (ctx) => {
      await this.handleMuteDuration(ctx);
    });

    this.bot.action('mute:reactivate', async (ctx) => {
      await this.handleMuteReactivate(ctx);
    });

    this.bot.action('mute:change', async (ctx) => {
      await this.handleMuteChange(ctx);
    });

    this.bot.action('mute:cancel', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        await ctx.deleteMessage();
      } catch (error) {
        this.logger.warn(`⚠️ Error handling mute cancel: ${error}`, error);
      }
    });

    this.bot.command('status', async (ctx) => {
      await this.handleStatusButton(ctx);
    });

    this.bot.help(async (ctx) => {
      const lng = await this.getUserLanguageFromChatId(
        ctx.chat.id.toString()
      );
      await ctx.reply(i18n.t('Available commands', { lng }));
    });
  }

  private async handleStartWithoutToken(ctx: Context): Promise<void> {
    const chatId = ctx.chat.id.toString();
    const lng = await this.getUserLanguageFromChatId(chatId);
    const config = await this.telegramConfigRepository.findOne({
      where: { chat_id: chatId, status: TelegramLinkStatus.LINKED },
    });
    const welcomeMessage = i18n.t('Welcome to SentryGuard Bot', { lng });

    if (config) {
      await this.safeReply(ctx, welcomeMessage, this.buildMainMenuKeyboard(lng, config.muted_until));
    } else {
      await this.safeReply(ctx, welcomeMessage);
    }
  }

  private async handleStatusButton(ctx: Context): Promise<void> {
    const chatId = ctx.chat.id.toString();
    const lng = await this.getUserLanguageFromChatId(chatId);
    const config = await this.telegramConfigRepository.findOne({
      where: { chat_id: chatId, status: TelegramLinkStatus.LINKED },
    });

    if (!config) {
      await this.safeReply(ctx, i18n.t('No account linked', { lng }));
      return;
    }

    const vehicles = await this.vehicleRepository.find({ where: { userId: config.userId } });
    await this.safeReply(ctx, this.buildConfigurationStatusMessage(config, vehicles, lng), this.buildMainMenuKeyboard(lng, config.muted_until));
  }

  private buildConfigurationStatusMessage(
    config: TelegramConfig,
    vehicles: Vehicle[],
    lng: 'en' | 'fr'
  ): string {
    return [
      i18n.t('configStatusTitle', { lng }),
      '',
      this.buildTelegramSection(config, lng),
      '',
      this.buildVehiclesSection(vehicles, lng),
    ].join('\n');
  }

  private buildTelegramSection(config: TelegramConfig, lng: 'en' | 'fr'): string {
    const locale = lng === 'fr' ? 'fr-FR' : 'en-GB';
    const date = config.linked_at
      ? config.linked_at.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' })
      : '—';
    const lines = [i18n.t('configStatusTelegram', { lng }), i18n.t('configStatusTelegramLinked', { lng, date })];

    if (config.muted_until && new Date() < config.muted_until) {
      lines.push(i18n.t('configStatusMutedUntil', { lng, duration: this.formatRemainingTime(config.muted_until) }));
    }

    return lines.join('\n');
  }

  private buildVehiclesSection(vehicles: Vehicle[], lng: 'en' | 'fr'): string {
    const header = i18n.t('configStatusVehicles', { lng });

    if (vehicles.length === 0) {
      return [header, i18n.t('configStatusNoVehicles', { lng })].join('\n');
    }

    return [header, ...vehicles.map((vehicle) => this.buildVehicleLine(vehicle, lng))].join('\n');
  }

  private buildVehicleLine(vehicle: Vehicle, lng: 'en' | 'fr'): string {
    const name = vehicle.display_name || vehicle.vin;
    const telemetryKey = vehicle.telemetry_enabled ? 'configStatusTelemetryActive' : 'configStatusTelemetryInactive';

    return `• ${name} — ${i18n.t(telemetryKey, { lng })}`;
  }

  private buildMainMenuKeyboard(lng: 'en' | 'fr', mutedUntil: Date | null | undefined = null): TelegramMessageOptions {
    const isMuted = mutedUntil != null && new Date() < mutedUntil;
    const muteButtonKey = isMuted ? 'menuButtonMuteActive' : 'menuButtonMute';

    return {
      keyboard: {
        keyboard: [[
          { text: i18n.t('menuButtonStatus', { lng }) },
          { text: i18n.t(muteButtonKey, { lng }) },
        ]],
        resize_keyboard: true,
      },
    };
  }

  private async handleMuteButton(ctx: Context): Promise<void> {
    const chatId = ctx.chat.id.toString();
    const lng = await this.getUserLanguageFromChatId(chatId);
    const config = await this.telegramConfigRepository.findOne({
      where: { chat_id: chatId, status: TelegramLinkStatus.LINKED },
    });

    if (config?.muted_until && new Date() < config.muted_until) {
      const duration = this.formatRemainingTime(config.muted_until);
      await this.safeReply(ctx, i18n.t('muteAlreadyActive', { lng, duration }), this.buildMuteActiveKeyboard(lng));
    } else {
      await this.safeReply(ctx, i18n.t('muteDurationTitle', { lng }), this.buildMuteDurationKeyboard());
    }
  }

  private buildMuteActiveKeyboard(lng: 'en' | 'fr'): TelegramMessageOptions {
    return {
      keyboard: {
        inline_keyboard: [
          [{ text: i18n.t('muteReactivate', { lng }), callback_data: 'mute:reactivate' }],
          [{ text: i18n.t('muteChangeDuration', { lng }), callback_data: 'mute:change' }],
          [{ text: '❌', callback_data: 'mute:cancel' }],
        ],
      },
    };
  }

  private async handleMuteReactivate(ctx: Context): Promise<void> {
    try {
      const chatId = ctx.chat.id.toString();
      const lng = await this.getUserLanguageFromChatId(chatId);
      await this.clearMutedUntil(chatId);
      await ctx.answerCbQuery();
      await ctx.deleteMessage();
      await this.safeReply(ctx, i18n.t('muteReactivated', { lng }), this.buildMainMenuKeyboard(lng));
    } catch (error) {
      this.logger.warn(`⚠️ Error handling mute reactivate: ${error}`, error);
      await ctx.answerCbQuery();
    }
  }

  private async handleMuteChange(ctx: Context): Promise<void> {
    try {
      const chatId = ctx.chat.id.toString();
      const lng = await this.getUserLanguageFromChatId(chatId);
      await ctx.answerCbQuery();
      await ctx.deleteMessage();
      await this.safeReply(ctx, i18n.t('muteDurationTitle', { lng }), this.buildMuteDurationKeyboard());
    } catch (error) {
      this.logger.warn(`⚠️ Error handling mute change: ${error}`, error);
      await ctx.answerCbQuery();
    }
  }

  private async clearMutedUntil(chatId: string): Promise<void> {
    await this.telegramConfigRepository.update(
      { chat_id: chatId, status: TelegramLinkStatus.LINKED },
      { muted_until: null }
    );
  }

  private buildMuteDurationKeyboard(): TelegramMessageOptions {
    return {
      keyboard: {
        inline_keyboard: this.buildMuteDurationRows(),
      },
    };
  }

  private buildMuteDurationRows(): Array<Array<{ text: string; callback_data: string }>> {
    return [
      [
        { text: '30 min', callback_data: 'mute:30' },
        { text: '1h', callback_data: 'mute:60' },
        { text: '2h', callback_data: 'mute:120' },
      ],
      [
        { text: '4h', callback_data: 'mute:240' },
        { text: '8h', callback_data: 'mute:480' },
        { text: '24h', callback_data: 'mute:1440' },
      ],
      [{ text: '❌', callback_data: 'mute:cancel' }],
    ];
  }

  private async handleMuteDuration(ctx: Context): Promise<void> {
    try {
      const minutes = parseInt(ctx.match[1]);
      const chatId = ctx.chat.id.toString();
      const lng = await this.getUserLanguageFromChatId(chatId);
      const mutedUntil = new Date(Date.now() + minutes * 60 * 1000);

      await this.saveMutedUntil(chatId, mutedUntil);
      await this.confirmMute(ctx, mutedUntil, lng);
    } catch (error) {
      this.logger.warn(`⚠️ Error handling mute duration: ${error}`, error);
      await ctx.answerCbQuery();
    }
  }

  private async saveMutedUntil(chatId: string, mutedUntil: Date): Promise<void> {
    await this.telegramConfigRepository.update(
      { chat_id: chatId, status: TelegramLinkStatus.LINKED },
      { muted_until: mutedUntil }
    );
  }

  private async confirmMute(ctx: Context, mutedUntil: Date, lng: 'en' | 'fr'): Promise<void> {
    const confirmation = i18n.t('muteConfirmed', { lng, duration: this.formatRemainingTime(mutedUntil) });
    await ctx.answerCbQuery();
    await ctx.deleteMessage();
    await this.safeReply(ctx, confirmation, this.buildMainMenuKeyboard(lng, mutedUntil));
  }

  private formatRemainingTime(date: Date): string {
    const totalMinutes = Math.ceil((date.getTime() - Date.now()) / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours > 0 && minutes > 0) return `${hours}h ${minutes}min`;
    if (hours > 0) return `${hours}h`;
    return `${Math.max(1, totalMinutes)}min`;
  }

  private async setupPollingMode() {
    if (!this.bot) return;

    this.logger.log('🔄 Configuring bot in polling mode...');

    try {
      this.bot.launch();

      this.logger.log('✅ Telegram bot running in polling mode.');
    } catch (error) {
      this.logger.error('❌ Error while trying to run polling:', error);
      throw error;
    }
  }

  private async setupWebhookMode() {
    if (!this.bot) return;

    if (!this.webhookBaseUrl) {
      this.logger.warn(
        '⚠️ TELEGRAM_WEBHOOK_BASE not defined, Telegram bot webhook disabled'
      );
      return;
    }

    const sanitizedWebhookPath = this.webhookSecretPath
      ? this.webhookSecretPath.replace(/^\//, '')
      : undefined;

    if (!sanitizedWebhookPath || sanitizedWebhookPath.length < 16) {
      this.logger.error(
        '❌ TELEGRAM_WEBHOOK_SECRET_PATH must be a non-guessable value (16+ chars)'
      );
      return;
    }

    if (!this.webhookSecretToken || this.webhookSecretToken.length < 24) {
      this.logger.error(
        '❌ TELEGRAM_WEBHOOK_SECRET_TOKEN must be defined (24+ chars) to accept webhook updates'
      );
      return;
    }

    try {
      const webhookPath = this.getWebhookPath(sanitizedWebhookPath);
      const webhookUrl = `${this.webhookBaseUrl.replace(/\/$/, '')}${webhookPath}`;

      await this.bot.telegram.setWebhook(webhookUrl, {
        secret_token: this.webhookSecretToken,
        drop_pending_updates: true,
      });

      this.webhookCallback = this.bot.webhookCallback(webhookPath);
      this.logger.log(
        `✅ Telegram bot configured with webhook on ${webhookUrl} (secure secret path)`
      );
    } catch (error) {
      this.logger.error('❌ Error while trying to configure webhook:', error);
      throw error;
    }
  }

  private async handleLinkToken(
    ctx: Context,
    linkToken: string
  ): Promise<void> {
    try {
      const config = await this.findPendingConfig(linkToken);
      const lng = await this.getLanguageForConfig(config);

      if (!config) {
        await this.safeReply(ctx, i18n.t('Invalid or expired token', { lng }));
        return;
      }

      const isExpired = await this.handleExpiredToken(ctx, config, lng);
      if (isExpired) return;

      await this.linkAccountToChat(ctx, config, lng);
    } catch (error) {
      this.logger.error('❌ Error while trying to handle link token:', error);
      await this.safeReply(ctx, '❌ An error occurred. Please try again later.');
    }
  }

  private async findPendingConfig(linkToken: string): Promise<TelegramConfig | null> {
    return await this.telegramConfigRepository.findOne({
      where: { link_token: linkToken, status: TelegramLinkStatus.PENDING },
    });
  }

  private async getLanguageForConfig(config: TelegramConfig | null): Promise<'en' | 'fr'> {
    return config
      ? await this.userLanguageService.getUserLanguage(config.userId)
      : 'en';
  }

  private async handleExpiredToken(
    ctx: Context,
    config: TelegramConfig,
    lng: 'en' | 'fr'
  ): Promise<boolean> {
    if (config.expires_at && new Date() > config.expires_at) {
      config.status = TelegramLinkStatus.EXPIRED;
      await this.telegramConfigRepository.save(config);
      await this.safeReply(ctx, i18n.t('This token has expired', { lng }));
      return true;
    }
    return false;
  }

  private async linkAccountToChat(
    ctx: Context,
    config: TelegramConfig,
    lng: 'en' | 'fr'
  ): Promise<void> {
    const chatId = ctx.chat?.id?.toString();
    if (!chatId) {
      this.logger.warn('⚠️ chatId missing in Telegram update');
      await this.safeReply(ctx, '❌ Unable to process this request.');
      return;
    }

    await this.saveLinkConfig(config, chatId);
    await this.sendLinkSuccessMessages(ctx, lng);
  }

  private async saveLinkConfig(config: TelegramConfig, chatId: string): Promise<void> {
    config.chat_id = chatId;
    config.status = TelegramLinkStatus.LINKED;
    config.linked_at = new Date();
    await this.telegramConfigRepository.save(config);

    this.logger.log(`✅ Account linked: userId=${config.userId}, chatId=${chatId}`);
  }

  private async sendLinkSuccessMessages(ctx: Context, lng: 'en' | 'fr'): Promise<void> {
    await this.safeReply(
      ctx,
      i18n.t('Your SentryGuard account has been linked successfully!', { lng })
    );

    await this.safeReply(ctx, i18n.t('telegramLinkedFollowUp', { lng }), this.buildMainMenuKeyboard(lng));
  }

  private getWebhookPath(secretPath: string): string {
    return `/telegram/webhook/${secretPath}`;
  }

  private async getUserLanguageFromChatId(
    chatId: string
  ): Promise<'en' | 'fr'> {
    try {
      const config = await this.telegramConfigRepository.findOne({
        where: { chat_id: chatId, status: TelegramLinkStatus.LINKED },
      });

      if (!config) {
        return 'en';
      }

      return await this.userLanguageService.getUserLanguage(config.userId);
    } catch (error) {
      this.logger.warn(
        `⚠️ Unable to get user language for chatId ${chatId}, defaulting to 'en'`,
        error
      );
      return 'en';
    }
  }
}
