import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';

/**
 * TraceLogger:把 Agent 每一步"做了什么、看到什么、结果如何"全部落盘。
 *
 * 为什么它是必备组件:Agent 循环对使用者是个黑盒 —— 出问题时,
 * 只有靠痕迹才能回答"模型当时看到了什么、为什么做出那个决定"。
 * 这也是 Stage 6 目标"会记录截图、DOM、动作日志,方便复盘"的落地。
 *
 * 每次运行生成独立目录 traces/run-<时间戳>/:
 *   actions.jsonl  每行一个 JSON 事件(工具调用/安全拦截/模型行为),机器可分析
 *   screenshots/   每次观察页面时的视口截图,肉眼核对模型"看到"的内容
 *   report.md      最终回答,无需翻日志即可浏览运行成果
 */

export type ActionKind = 'info' | 'tool' | 'safety' | 'final';

export interface ActionEntry {
  /** ISO 时间戳 */
  time: string;
  /** 对应第几次模型决策(0 表示运行级事件) */
  step: number;
  /** 事件类型:safety 意味着"被安全策略拦截",复盘时优先看这类 */
  kind: ActionKind;
  /** 涉及的工具名(可选) */
  tool?: string;
  /** 工具入参(可选) */
  input?: unknown;
  /** 人读的结果摘要(截断,防日志膨胀) */
  summary: string;
  /** 附属信息,如截图路径 */
  screenshot?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class TraceLogger {
  /** 本次运行的痕迹目录(对外暴露,CLI 结束时提示用户去这里复盘) */
  readonly runDir: string;
  private readonly screenshotsDir: string;
  /** 当前步骤号:与模型决策次数对齐 */
  private step = 0;

  constructor(
    private readonly task: string,
    traceRoot: string,
  ) {
    // 时间戳里冒号/点在 Windows 文件名里非法,统一替换成连字符
    const stamp = nowIso().replace(/[:.]/g, '-');
    this.runDir = join(traceRoot, `run-${stamp}`);
    this.screenshotsDir = join(this.runDir, 'screenshots');
    // recursive: true —— 一次性建出多级目录
    mkdirSync(this.screenshotsDir, { recursive: true });
    this.append({
      time: nowIso(),
      step: 0,
      kind: 'info',
      summary: `任务:${task}`,
    });
  }

  /** 每次模型发起新一轮决策前调用,返回自增后的步骤号 */
  nextStep(): number {
    return ++this.step;
  }

  /** 核心:追加一条事件到 actions.jsonl(JSONL = 每行一个 JSON,可流式追加、可 grep) */
  append(entry: ActionEntry): void {
    appendFileSync(
      join(this.runDir, 'actions.jsonl'),
      JSON.stringify(entry) + '\n',
      'utf8',
    );
  }

  /** 工具调用的便捷记录 */
  logTool(tool: string, input: unknown, summary: string, screenshot?: string): void {
    this.append({ time: nowIso(), step: this.step, kind: 'tool', tool, input, summary, screenshot });
  }

  /** 安全拦截的便捷记录:被拦下的尝试是安全审计最有价值的数据 */
  logSafety(tool: string, summary: string): void {
    this.append({ time: nowIso(), step: this.step, kind: 'safety', tool, summary });
  }

  /**
   * 截取当前页面视口并保存到痕迹目录。
   * 注意只截视口(fullPage: false):模型的快照同样只描述当前视口内可见内容,
   * 两者保持一致,截图才能真实反映"模型看到了什么"。
   */
  async saveScreenshot(page: Page, label: string): Promise<string> {
    const file = `${String(this.step).padStart(2, '0')}-${label}.png`;
    const path = join(this.screenshotsDir, file);
    await page.screenshot({ path, fullPage: false });
    return path;
  }

  /** 运行结束时保存最终回答,方便快速浏览 */
  saveReport(answer: string): void {
    const content = [
      '# 浏览器 Agent 运行报告',
      '',
      `- 时间:${nowIso()}`,
      `- 任务:${this.task}`,
      `- 步骤数:${this.step}`,
      '',
      '## Agent 最终输出',
      '',
      answer || '(无输出:可能达到了步数上限,请查看 actions.jsonl 复盘)',
      '',
    ].join('\n');
    writeFileSync(join(this.runDir, 'report.md'), content, 'utf8');
  }
}
