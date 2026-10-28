import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { BrowserSession } from './session.js';
import type { SafetyPolicy } from '../safety/policy.js';
import type { RobotsChecker } from '../safety/robots.js';
import type { TraceLogger } from '../trace/logger.js';

/**
 * 浏览器工具集:Agent 的"手和眼"。
 *
 * Stage 6 目标"会用 Playwright 做网页观察和点击"就体现在这里。
 *
 * 观察机制 —— aria 快照(Accessibility Snapshot),这是本项目最核心的设计决策:
 * - Playwright 的 ariaSnapshot() 输出页面的无障碍树(YAML 文本),
 *   只保留"可交互元素 + 可读文本",每个元素带 ref 编号(如 [ref=e12]);
 * - 模型拿着 ref 编号调用 browser_click / browser_type,由
 *   page.locator(`aria-ref=<ref>`) 精确还原到真实 DOM 节点;
 * - 对比三种观察方案:原始 HTML(几百 KB,撑爆上下文)、截图(只有多模态模型
 *   能读,token 贵)、aria 快照(几十行文本,任何模型可用)—— 快照是当前
 *   Playwright MCP / Claude 等浏览器 agent 的主流做法,也是面试的加分知识点。
 *
 * 工具设计三原则(写工具时时刻回看):
 * 1. 少而正交:6 个原子动作覆盖"看/点/输入/滚动/留证",复杂任务靠组合;
 * 2. 错误也是信息:失败返回"带下一步建议的错误说明",而不是抛异常炸掉循环;
 * 3. 上下文友好:快照超长必须截断,上下文窗口是 agent 最稀缺的资源。
 */

/** 单次快照返回给模型的最大字符数。过大 → 上下文爆炸;过小 → 信息不足 */
const SNAPSHOT_MAX_CHARS = 6_000;

function clip(text: string, max = SNAPSHOT_MAX_CHARS): string {
  if (text.length <= max) return text;
  return (
    text.slice(0, max) +
    `\n...[快照已截断,仅显示前 ${max} 字符。可滚动页面查看其余内容]`
  );
}

/** 描述"当前页面的观察结果":所有会改变页面的工具都以它作为返回结构 */
async function describePage(
  session: BrowserSession,
  logger: TraceLogger,
  label: string,
): Promise<Record<string, unknown>> {
  const page = session.page;
  const title = await page.title();
  // ariaSnapshot 偶发失败(页面正在跳转):降级为占位文本而不是中断循环
  const snapshot = await page
    .locator('body')
    .ariaSnapshot()
    .catch(() => '(页面结构暂不可用,请稍后重试 browser_snapshot)');
  // 每次观察都留档截图:复盘时对照"模型当时看到了什么"
  const screenshot = await logger.saveScreenshot(page, label);
  return {
    url: page.url(),
    title,
    screenshot,
    snapshot: clip(snapshot),
  };
}

/**
 * 组装浏览器工具集。
 * 采用依赖注入(参数传入 session/policy/robots/logger)而非模块内单例:
 * 任何部件都可以被替换或 mock,smoke 测试因此可以不碰模型、只测工具层。
 */
export function createBrowserTools(
  session: BrowserSession,
  policy: SafetyPolicy,
  robots: RobotsChecker,
  logger: TraceLogger,
): ToolSet {
  return {
    browser_navigate: tool({
      description:
        '打开一个网页。仅允许白名单内的公开页面,并遵守 robots.txt。' +
        '成功后返回页面标题、结构与元素 ref 编号。',
      inputSchema: z.object({
        url: z.string().describe('完整的 http(s) 地址,如 https://quotes.toscrape.com/'),
      }),
      execute: async ({ url }) => {
        logger.nextStep();

        // ---- 防线 1:域名白名单(事前拦截)----
        const check = policy.checkUrl(url);
        if (!check.ok) {
          logger.logSafety('browser_navigate', check.reason);
          return { blocked: check.reason };
        }

        // ---- 防线 2:robots.txt(尊重平台规则)----
        const robotsCheck = await robots.isAllowed(check.url);
        if (!robotsCheck.allowed) {
          logger.logSafety('browser_navigate', robotsCheck.reason ?? '');
          return { blocked: robotsCheck.reason };
        }

        const result = await session.goto(check.url.href);
        if (!result.ok) {
          logger.logTool('browser_navigate', { url }, `失败:${result.error}`);
          return { error: result.error };
        }

        // ---- 防线 1 复核:重定向可能把我们带到白名单之外 ----
        // 白名单无法逐"跳"拦截(HTTP 302 发生在服务器端),
        // 所以落地后必须复核最终 URL,这叫"事后校验"模式
        const finalHost = new URL(session.page.url()).hostname.toLowerCase();
        if (!policy.isHostAllowed(finalHost)) {
          // 退回空白页,切断与该站点的后续交互
          await session.page.goto('about:blank').catch(() => {});
          const reason = `安全策略:${url} 重定向到了白名单外的 ${finalHost},已停止访问。`;
          logger.logSafety('browser_navigate', reason);
          return { blocked: reason };
        }

        logger.logTool('browser_navigate', { url }, `已打开 ${session.page.url()}`);
        return describePage(session, logger, 'navigate');
      },
    }),

    browser_snapshot: tool({
      description:
        '重新获取当前页面的结构与元素 ref 编号。当页面变化、ref 失效,或需要最新信息时调用。',
      inputSchema: z.object({}),
      execute: async () => {
        logger.nextStep();
        logger.logTool('browser_snapshot', {}, `重新观察 ${session.page.url()}`);
        return describePage(session, logger, 'snapshot');
      },
    }),

    browser_click: tool({
      description:
        '点击快照中 ref 编号对应的元素。点击后页面可能变化,请以返回的最新快照为准。',
      inputSchema: z.object({
        ref: z.string().describe('快照中目标元素的 ref 编号,如 "e12"'),
        purpose: z.string().describe('一句话说明点击目的,会写入操作日志便于复盘'),
      }),
      execute: async ({ ref, purpose }) => {
        logger.nextStep();
        const page = session.page;
        const before = page.url();

        try {
          // aria-ref 是 Playwright 内置选择器引擎,与 ariaSnapshot 的 ref 编号配套;
          // 5s 超时:超时大概率意味着 ref 已失效(页面已变化),不值得干等 10s
          await page.locator(`aria-ref=${ref}`).click({ timeout: 5_000 });
        } catch {
          // 元素定位失败 = 浏览器 agent 最常见的运行时错误。
          // 返回"原因 + 行动指引"让模型自我纠正,而不是抛异常终止整个任务
          const msg =
            `ref "${ref}" 定位失败:元素可能已随页面更新而失效。` +
            `请重新调用 browser_snapshot,改用最新快照中的 ref 重试。`;
          logger.logTool('browser_click', { ref, purpose }, `定位失败:${msg}`);
          return { error: msg };
        }

        // 点击后页面行为不确定(同页渲染/跳转/弹新页),统一等 DOM 稳定 + 渲染缓冲
        await page
          .waitForLoadState('domcontentloaded', { timeout: 5_000 })
          .catch(() => {});
        await page.waitForTimeout(400);

        // 事后校验:链接可能把浏览器带到白名单之外
        const finalHost = new URL(page.url()).hostname.toLowerCase();
        if (!policy.isHostAllowed(finalHost)) {
          const reason = `点击后跳转到了白名单外的域名 ${finalHost},请不要在该页面继续操作,返回原站点。`;
          logger.logSafety('browser_click', reason);
          return { warning: reason, ...(await describePage(session, logger, `click-${ref}`)) };
        }

        logger.logTool(
          'browser_click',
          { ref, purpose },
          `${before} -> ${page.url()}`,
        );
        return describePage(session, logger, `click-${ref}`);
      },
    }),

    browser_type: tool({
      description:
        '向快照中 ref 对应的输入框填写文本。可选 submit=true 表示填写后按回车。禁止向密码框填写。',
      inputSchema: z.object({
        ref: z.string().describe('快照中目标输入框的 ref 编号,如 "e5"'),
        text: z.string().describe('要填写的文本'),
        submit: z.boolean().optional().describe('填写后是否按回车提交,默认 false'),
      }),
      execute: async ({ ref, text, submit }) => {
        logger.nextStep();
        const page = session.page;
        const locator = page.locator(`aria-ref=${ref}`);

        // ---- 防线 3:密码框拦截 ----
        // 即使站点在白名单内,也禁止填密码:agent 永远不该接触凭据。
        // 用 DOM 结构判断而非 URL 关键字 —— 前者精确,后者容易被绕过或误伤。
        // evaluate 回调在页面上下文执行;这里用 tagName+type 结构判断,
        // 避免 Node 项目为了一个类型引入整个 DOM 类型库
        const isPassword = await locator
          .evaluate(
            (el) =>
              (el as { tagName?: string }).tagName === 'INPUT' &&
              (el as { type?: string }).type === 'password',
          )
          .catch(() => false);
        if (isPassword) {
          const reason =
            '安全策略:检测到密码输入框,禁止填写(不登录敏感账号)。' +
            '如果任务必须登录才能继续,请停止任务并说明原因。';
          logger.logSafety('browser_type', reason);
          return { blocked: reason };
        }

        try {
          // fill 会先清空再输入,语义比 type 稳定(不追加在旧文本后)
          await locator.fill(text, { timeout: 5_000 });
          if (submit) await locator.press('Enter');
        } catch {
          const msg =
            `ref "${ref}" 填写失败:元素可能不可输入或已失效。` +
            `请重新调用 browser_snapshot 确认输入框位置后重试。`;
          logger.logTool('browser_type', { ref, text, submit }, `失败:${msg}`);
          return { error: msg };
        }

        if (submit) {
          await page
            .waitForLoadState('domcontentloaded', { timeout: 5_000 })
            .catch(() => {});
          await page.waitForTimeout(400);
        }
        logger.logTool(
          'browser_type',
          { ref, text, submit },
          submit ? '已填写并提交' : '已填写',
        );
        return describePage(session, logger, `type-${ref}`);
      },
    }),

    browser_scroll: tool({
      description: '向上或向下滚动一屏,用于查看当前视口之外的内容。',
      inputSchema: z.object({
        direction: z.enum(['up', 'down']).describe('滚动方向'),
      }),
      execute: async ({ direction }) => {
        logger.nextStep();
        const page = session.page;
        // mouse.wheel 模拟真实滚轮:对懒加载页面(滚动才加载内容)同样有效
        await page.mouse.wheel(0, direction === 'down' ? 700 : -700);
        await page.waitForTimeout(300);
        logger.logTool('browser_scroll', { direction }, `已向${direction === 'down' ? '下' : '上'}滚动`);
        return describePage(session, logger, `scroll-${direction}`);
      },
    }),

    browser_screenshot: tool({
      description: '截取当前页面并存档(不会返回给模型,仅用于留证与复盘)。',
      inputSchema: z.object({}),
      execute: async () => {
        logger.nextStep();
        const path = await logger.saveScreenshot(session.page, 'manual-shot');
        logger.logTool('browser_screenshot', {}, `截图已保存:${path}`);
        return { saved: path };
      },
    }),
  };
}
