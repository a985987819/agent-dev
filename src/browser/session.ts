import {
  chromium,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import type { TraceLogger } from '../trace/logger.js';

/**
 * BrowserSession:浏览器生命周期管理 + 健壮性兜底。
 *
 * Stage 6 目标"会处理页面变化、弹窗、加载失败、元素定位失败"在这里落地:
 * - JS 弹窗(alert/confirm/prompt):自动关闭并记录。
 *   原因:原生弹窗会挂起页面脚本,若不自动处理,后续所有操作都会被卡死;
 *   且模型根本"看不到"原生弹窗,把它交给模型决策没有意义 —— 能做的只有关掉。
 * - 新标签页(window.open / target=_blank):通过 context 的 page 事件自动纳入
 *   管理,并切换为"当前页"。这是"页面变化"最常见的两种形态之一(另一种是同页刷新)。
 * - 加载失败:goto 抛出的异常被捕获并转成"可读错误 + 下一步建议"返回给模型,
 *   让模型自己决定重试还是换路径 —— 错误也是信息,这是 agent 工程的关键心法。
 * - 元素定位失败:在 tools.ts 处理(定位与页面结构强相关,职责放在工具层)。
 * - 限速:两次导航至少间隔 MIN_NAV_INTERVAL_MS,做"礼貌"的自动化访问者。
 */

/** 页面导航超时:domcontentloaded 通常几秒内完成,20s 已是宽裕上限 */
const NAV_TIMEOUT_MS = 20_000;
/** 相同浏览器的两次导航最小间隔(毫秒):避免高频请求给目标站点造成压力 */
const MIN_NAV_INTERVAL_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BrowserSession {
  private browser!: Browser;
  private context!: BrowserContext;
  /** 打开过的所有标签页;约定"最后一个"是当前操作页 */
  private pages: Page[] = [];
  /** 上次导航完成时刻,用于限速 */
  private lastNavAt = 0;

  /** 当前页。工具层都通过它访问页面,换页逻辑收敛在一处 */
  get page(): Page {
    const page = this.pages.at(-1);
    if (!page) throw new Error('浏览器尚未启动或没有可用标签页');
    return page;
  }

  /**
   * 暴露浏览器上下文的网络栈(APIRequestContext)。
   * 供 robots 检查器复用:同一 UA、同一 Cookie 上下文,站点看到的是同一个访客。
   * 用 getter 而非把 context 设为 public:精确控制暴露面,防止外部拿到整个
   * context 绕过会话层直接建页面。
   */
  get apiRequest(): APIRequestContext {
    return this.context.request;
  }

  /** 启动浏览器:启动本身失败是环境问题,直接抛给调用方(CLI 层报错退出) */
  async start(logger: TraceLogger, headless: boolean): Promise<void> {
    this.browser = await chromium.launch({ headless });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      /**
       * 诚实标识自己的 UA:表明自动化用途。
       * 这不是"伪装绕过检测",而是"明示身份" —— 与"不绕过平台规则"一致。
       * 若目标站点明确拒绝自动化访问,应换用其开放 API 而不是伪装 UA。
       */
      userAgent:
        'Mozilla/5.0 (compatible; AgentDevBrowserAgent/0.1; educational-demo)',
    });

    // 新标签页出现(window.open / target=_blank)时自动接管:
    // 登记进 pages 列表即完成"切换当前页"(page getter 取最后一个)
    this.context.on('page', (page) => {
      this.wirePage(page, logger);
      this.pages.push(page);
      logger.append({
        time: new Date().toISOString(),
        step: 0,
        kind: 'info',
        summary: `检测到新标签页,已切换为当前页(共 ${this.pages.length} 个)`,
      });
    });

    const first = await this.context.newPage();
    this.wirePage(first, logger);
    this.pages.push(first);
  }

  /**
   * 给每个新页面的统一配置与监听。
   * 必须在页面开始任何操作前挂好 —— 弹窗监听晚了就会漏掉最早的弹窗。
   */
  private wirePage(page: Page, logger: TraceLogger): void {
    // 页面内单次操作(点击/填写等)的默认超时:超时后由工具层转成可读错误
    page.setDefaultTimeout(10_000);

    // 原生 JS 弹窗:自动关闭 + 记录。
    // 注意用 void 显式忽略 promise rejection(dismiss 也可能因页面关闭失败),避免 unhandled rejection
    page.on('dialog', (dialog) => {
      logger.append({
        time: new Date().toISOString(),
        step: 0,
        kind: 'info',
        summary: `自动关闭 JS 弹窗 [${dialog.type()}]:"${dialog.message().slice(0, 120)}"`,
      });
      void dialog.dismiss().catch(() => {});
    });
  }

  /**
   * 导航到指定 URL。所有"加载失败"都收敛为 { ok: false, error } 结构:
   * 调用方(工具层)把 error 原样返回给模型,由它决策下一步。
   */
  async goto(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
    // 限速:距上次导航不足间隔时,补足等待
    const elapsed = Date.now() - this.lastNavAt;
    if (elapsed < MIN_NAV_INTERVAL_MS) {
      await sleep(MIN_NAV_INTERVAL_MS - elapsed);
    }

    try {
      /**
       * waitUntil 选 domcontentloaded 而非 load:
       * load 要等所有子资源(图片/字体),慢站点会拖垮 agent;
       * domcontentloaded 时 DOM 已可解析,配合下面的 networkidle 缓冲,
       * 兼顾速度与稳定 —— 这是爬虫/自动化领域的常见组合拳。
       */
      const resp = await this.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      });

      // 再等网络空闲(最多 3s),让首屏数据接口基本返回;
      // 等不到不算失败 —— 长轮询/SSE 站点永远达不到 networkidle,静默降级
      await this.page
        .waitForLoadState('networkidle', { timeout: 3_000 })
        .catch(() => {});

      this.lastNavAt = Date.now();

      // HTTP 层面的失败(404/500)不是异常而是状态码:主动识别并报告
      if (resp && resp.status() >= 400) {
        return {
          ok: false,
          error: `页面返回 HTTP ${resp.status()}(${url})。可检查 URL 是否正确,或先浏览站点其他页面。`,
        };
      }
      return { ok: true };
    } catch (err) {
      // 超时/DNS 失败/连接拒绝等全部收敛为可读错误
      return {
        ok: false,
        error: `导航失败:${(err as Error).message.split('\n')[0]}。可稍后重试、检查 URL,或改试其他页面。`,
      };
    }
  }

  /** 释放浏览器进程。放 finally 里调用,保证异常路径也不留下僵尸 chromium */
  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
  }
}
