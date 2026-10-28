import 'dotenv/config';
import { config } from './config.js';
import { TraceLogger } from './trace/logger.js';
import { SafetyPolicy } from './safety/policy.js';
import { RobotsChecker } from './safety/robots.js';
import { BrowserSession } from './browser/session.js';
import { createBrowserTools } from './browser/tools.js';
import { runAgent } from './agent.js';

/**
 * CLI 入口:把所有模块组装起来并管理生命周期。
 *
 * 用法:
 *   npm run dev -- "打开 https://quotes.toscrape.com/ 提取前 5 条引言及作者,生成中文摘要"
 *
 * 组装方式是"手动依赖注入":每个部件在这里 new 出来再传给使用者,
 * 而不是模块内部各自 new 单例 —— 好处是依赖关系一目了然,
 * 任何部件(浏览器/模型/日志)都可以在测试或未来扩展中被替换。
 */
async function main(): Promise<void> {
  // 命令行所有参数拼成任务描述
  const task = process.argv.slice(2).join(' ').trim();
  if (!task) {
    console.error(
      '用法:npm run dev -- "打开 https://quotes.toscrape.com/ 提取前 5 条引言,生成中文摘要"',
    );
    process.exit(1);
  }

  console.log(`任务:${task}\n`);

  const logger = new TraceLogger(task, config.traceDir);
  const session = new BrowserSession();
  const policy = new SafetyPolicy(config.allowedDomains);

  // try/finally:无论成功还是中途报错,浏览器进程都必须被释放,
  // 否则会留下僵尸 chromium 进程占内存(Windows 下尤其烦人)
  try {
    await session.start(logger, config.headless);

    // robots 检查器需要复用浏览器的网络栈,所以等浏览器启动后再创建
    const robots = new RobotsChecker(session.apiRequest, (summary) =>
      logger.append({ time: new Date().toISOString(), step: 0, kind: 'info', summary }),
    );

    console.log('Agent 开始执行(工具调用将实时打印):\n');
    const { answer, steps } = await runAgent(
      task,
      createBrowserTools(session, policy, robots, logger),
      logger,
    );

    // 最终回答存入痕迹目录,终端同步输出
    logger.saveReport(answer);
    console.log(`\n===== 执行完成(共 ${steps} 步)=====\n`);
    console.log(answer || '(模型没有输出最终结论,请查看痕迹日志复盘)');
    console.log(`\n痕迹已保存到:${logger.runDir}`);
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  // 兜底错误处理:配置缺失/模型 401 等在这里统一呈现给用户
  console.error('\n运行失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
