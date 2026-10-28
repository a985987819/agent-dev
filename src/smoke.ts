import { config } from './config.js';
import { TraceLogger } from './trace/logger.js';
import { SafetyPolicy } from './safety/policy.js';
import { BrowserSession } from './browser/session.js';

/**
 * 冒烟测试:不调用任何模型,只验证"浏览器工具层"是否正常工作。
 *
 * 为什么需要它:排障第一步永远是隔离变量。浏览器 agent 的故障可能来自
 * 三层 —— 环境层(chromium 没装好/网络不通)、工具层(选择器/超时策略有 bug)、
 * 模型层(提示词/参数问题)。先跑 npm run smoke 确认前两层没问题,
 * 再谈模型问题,能省掉大量无效排查。它也不消耗任何 API token。
 *
 * 验证点(与 Stage 6 目标一一对应):
 * 1. 能导航 + 观察(example.com 快照应含标题文本)
 * 2. 白名单会拒绝白名单外域名(github.com 应被拒)
 * 3. 能点击链接并跟随跳转(example.com -> iana.org)
 * 4. 截图能落盘
 */

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`冒烟测试失败:${message}`);
}

async function main(): Promise<void> {
  console.log('开始冒烟测试(无模型,仅浏览器层)…\n');

  const logger = new TraceLogger('冒烟测试:验证浏览器工具层', config.traceDir);
  const session = new BrowserSession();
  const policy = new SafetyPolicy(config.allowedDomains);

  try {
    await session.start(logger, config.headless);
    const page = session.page;

    // ---- 验证 1:导航 + 观察 ----
    console.log('[1/4] 导航 example.com 并获取 aria 快照…');
    const goto = await session.goto('https://example.com/');
    assert(goto.ok, `导航 example.com 失败:${'error' in goto ? goto.error : ''}`);
    // 用 <title> 断言而不是页面正文:正文会随站点改版变化(2026 年 example.com
    // 就改过版),title 是最稳定的锚点 —— 这也是"页面变化"课题的第一课
    const title = await page.title();
    assert(title === 'Example Domain', `页面标题应为 "Example Domain",实际 "${title}"`);
    const snapshot = await page.locator('body').ariaSnapshot();
    assert(snapshot.length > 50, '快照应有实质内容');
    console.log(`      ✓ 快照 ${snapshot.length} 字符,内容符合预期`);

    // ---- 验证 2:白名单拦截 ----
    console.log('[2/4] 验证白名单拒绝白名单外域名…');
    const blocked = policy.checkUrl('https://github.com/');
    assert(!blocked.ok, 'github.com 不在默认白名单,应被拒绝');
    console.log(`      ✓ 已拦截:${blocked.ok ? '' : (blocked as { reason: string }).reason.slice(0, 50)}…`);

    // ---- 验证 3:点击 + 跳转 ----
    console.log('[3/4] 点击 "Learn more" 链接(应跳转到 iana.org)…');
    await page
      .getByRole('link', { name: /learn more/i })
      .click({ timeout: 15_000 });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    assert(
      page.url().includes('iana.org'),
      `点击后应到达 iana.org,实际为 ${page.url()}`,
    );
    console.log(`      ✓ 已跳转到 ${page.url()}`);

    // ---- 验证 4:截图留档 ----
    console.log('[4/4] 保存截图…');
    const shot = await logger.saveScreenshot(page, 'smoke-final');
    console.log(`      ✓ 截图已保存:${shot}`);

    console.log('\n✅ 冒烟测试全部通过:浏览器环境、导航、快照、点击、截图均正常。');
    console.log(`痕迹目录:${logger.runDir}`);
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('\n❌', err instanceof Error ? err.message : err);
  console.error('排查建议:npx playwright install chromium 重新安装内核;检查网络代理;');
  console.error('或设置 HEADLESS=false 运行,肉眼观察浏览器行为。');
  process.exit(1);
});
