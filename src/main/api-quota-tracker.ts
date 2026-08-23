/**
 * API 余量追踪器
 *
 * 负责：
 * - 持久化记录每个模型的 API 调用量
 * - 每天 00:00 自动将当日用量归档到 monthlyUsage
 * - 余量报警阈值检查
 * - 每月 1 号自动重置月度计数
 */

import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { createLogger } from '../shared/logger';

const logger = createLogger('ApiQuotaTracker');

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface APIModelQuota {
  /** 模型唯一标识 */
  modelId: string;
  /** 供应商，例如 openai / anthropic / hunyuan */
  provider: string;
  /** 每月总配额（tokens） */
  quotaTotal: number;
  /** 当月已用量（tokens） */
  quotaUsed: number;
  /** 报警阈值比例，默认 0.8 即 80% */
  quotaAlertThreshold: number;
  /** 每日用量归档（31 个槽位，按 day-of-month 索引） */
  monthlyUsage: number[];
  /** 上次月度重置时间戳 */
  lastResetAt: number;
}

interface QuotaCache {
  version: 1;
  updatedAt: number;
  models: Record<string, APIModelQuota>;
  /** 当日累计（day-of-month 索引） */
  todayUsage: Record<string, number>;
  /** 记录当前日期，用于零点归档判定 */
  todayDate: number; // day-of-month
}

// ---------------------------------------------------------------------------
// 持久化路径
// ---------------------------------------------------------------------------

function getQuotaCachePath(): string {
  const userData = app.getPath('userData');
  return path.join(userData, 'quota-cache.json');
}

// ---------------------------------------------------------------------------
// 单例
// ---------------------------------------------------------------------------

class ApiQuotaTracker {
  private cache: QuotaCache;
  private cachePath: string;
  /** 零点归档定时器 */
  private dailyTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.cachePath = getQuotaCachePath();
    this.cache = this.createEmptyCache();
    logger.info(`Quota cache path: ${this.cachePath}`);
  }

  // -------------------------------------------------------------------------
  // 初始化
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    this.loadFromDisk();
    this.checkMonthlyReset();
    this.checkDailyArchive();
    this.scheduleDailyReset();
    logger.info(
      `ApiQuotaTracker initialized. ${Object.keys(this.cache.models).length} model(s) tracked.`,
    );
  }

  // -------------------------------------------------------------------------
  // 持久化读写
  // -------------------------------------------------------------------------

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.cachePath)) {
        const raw = fs.readFileSync(this.cachePath, 'utf-8');
        const parsed = JSON.parse(raw) as QuotaCache;
        if (parsed.version === 1) {
          this.cache = parsed;
          logger.info(`Loaded quota cache from disk.`);
          return;
        }
      }
    } catch (err) {
      logger.warn(`Failed to load quota cache, using empty cache. ${String(err)}`);
    }
    this.cache = this.createEmptyCache();
  }

  private persist(): void {
    try {
      this.cache.updatedAt = Date.now();
      fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2), 'utf-8');
    } catch (err) {
      logger.error(`Failed to persist quota cache. ${String(err)}`);
    }
  }

  private createEmptyCache(): QuotaCache {
    return {
      version: 1,
      updatedAt: Date.now(),
      models: {},
      todayUsage: {},
      todayDate: new Date().getDate(),
    };
  }

  // -------------------------------------------------------------------------
  // 用量追踪
  // -------------------------------------------------------------------------

  trackUsage(modelId: string, tokens: number): void {
    if (!this.cache.models[modelId]) {
      logger.warn(`Model ${modelId} not registered yet, creating default entry.`);
      this.cache.models[modelId] = {
        modelId,
        provider: 'unknown',
        quotaTotal: 1_000_000,
        quotaUsed: 0,
        quotaAlertThreshold: 0.8,
        monthlyUsage: new Array(31).fill(0),
        lastResetAt: Date.now(),
      };
    }

    const model = this.cache.models[modelId];

    // 检查是否需要月度重置
    this.checkMonthlyResetForModel(model);

    model.quotaUsed += tokens;

    // 累加当日用量
    this.cache.todayUsage[modelId] =
      (this.cache.todayUsage[modelId] || 0) + tokens;

    // 检查零点归档（可能在两次调用之间跨天了）
    this.checkDailyArchive();

    this.persist();

    const usedPercent = model.quotaTotal > 0
      ? (model.quotaUsed / model.quotaTotal * 100).toFixed(1)
      : 'N/A';
    logger.info(
      `Tracked +${tokens} tokens for ${modelId}. Total: ${model.quotaUsed}/${model.quotaTotal} (${usedPercent}%)`,
    );

    // 报警检查
    if (this.checkAlert(modelId)) {
      logger.warn(
        `ALERT: ${modelId} quota usage (${usedPercent}%) has exceeded alert threshold (${model.quotaAlertThreshold * 100}%)`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 报警
  // -------------------------------------------------------------------------

  checkAlert(modelId: string): boolean {
    const model = this.cache.models[modelId];
    if (!model || model.quotaTotal <= 0) return false;
    return model.quotaUsed / model.quotaTotal >= model.quotaAlertThreshold;
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  getQuota(modelId: string): APIModelQuota | undefined {
    return this.cache.models[modelId];
  }

  getAllQuotas(): APIModelQuota[] {
    return Object.values(this.cache.models);
  }

  // -------------------------------------------------------------------------
  // 设置
  // -------------------------------------------------------------------------

  setAlertThreshold(modelId: string, threshold: number): void {
    if (!this.cache.models[modelId]) {
      logger.error(`Cannot set threshold: model ${modelId} not found.`);
      return;
    }
    this.cache.models[modelId].quotaAlertThreshold = Math.max(0, Math.min(1, threshold));
    logger.info(`Alert threshold for ${modelId} set to ${this.cache.models[modelId].quotaAlertThreshold}`);
    this.persist();
  }

  removeModel(modelId: string): void {
    delete this.cache.models[modelId];
    delete this.cache.todayUsage[modelId];
    logger.info(`Removed model ${modelId} from quota tracking.`);
    this.persist();
  }

  // -------------------------------------------------------------------------
  // 月度重置
  // -------------------------------------------------------------------------

  resetMonthly(): void {
    const now = Date.now();
    for (const model of Object.values(this.cache.models)) {
      model.quotaUsed = 0;
      model.monthlyUsage = new Array(31).fill(0);
      model.lastResetAt = now;
    }
    this.cache.todayUsage = {};
    logger.info(`Monthly quota reset executed.`);
    this.persist();
  }

  private checkMonthlyReset(): void {
    const now = new Date();
    for (const model of Object.values(this.cache.models)) {
      this.checkMonthlyResetForModel(model, now);
    }
  }

  private checkMonthlyResetForModel(model: APIModelQuota, nowDate?: Date): void {
    const now = nowDate ?? new Date();
    const last = new Date(model.lastResetAt);
    // 跨月则重置
    if (last.getMonth() !== now.getMonth() || last.getFullYear() !== now.getFullYear()) {
      model.quotaUsed = 0;
      model.monthlyUsage = new Array(31).fill(0);
      model.lastResetAt = now.getTime();
      logger.info(`Monthly reset triggered for ${model.modelId}`);
    }
  }

  // -------------------------------------------------------------------------
  // 每日归档
  // -------------------------------------------------------------------------

  /**
   * 如果当前 day-of-month 与缓存记录不一致，说明已跨天：
   * - 把当日累计写入对应模型的 monthlyUsage[旧日期]
   * - 清空 todayUsage
   */
  private checkDailyArchive(): void {
    const today = new Date().getDate();
    if (this.cache.todayDate !== today) {
      const yesterday = this.cache.todayDate;
      logger.info(`Daily archive: moving day-${yesterday} usage to monthlyUsage.`);
      for (const [modelId, usage] of Object.entries(this.cache.todayUsage)) {
        const model = this.cache.models[modelId];
        if (model) {
          model.monthlyUsage[yesterday - 1] = (model.monthlyUsage[yesterday - 1] || 0) + usage;
        }
      }
      this.cache.todayUsage = {};
      this.cache.todayDate = today;
      this.persist();
    }
  }

  /**
   * 计算到明天 00:00:00 的毫秒数，到时执行每日归档。
   */
  private scheduleDailyReset(): void {
    if (this.dailyTimer) clearTimeout(this.dailyTimer);

    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
    const msUntilMidnight = tomorrow.getTime() - now.getTime();

    this.dailyTimer = setTimeout(() => {
      this.checkDailyArchive();
      this.checkMonthlyReset();
      this.scheduleDailyReset(); // 递归调度下一天
    }, msUntilMidnight);

    logger.info(`Scheduled daily archive in ${(msUntilMidnight / 1000 / 60).toFixed(0)} minutes.`);
  }
}

// ---------------------------------------------------------------------------
// 导出单例
// ---------------------------------------------------------------------------

export const apiQuotaTracker = new ApiQuotaTracker();
