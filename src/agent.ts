import { generateText, stepCountIs, type ToolSet } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { config } from './config.js';
import type { TraceLogger } from './trace/logger.js';

/**
 * agent.ts:核心 Agent 循环 —— 项目的"大脑"。
 *
 * Agent 的本质是一个循环:模型观察(快照)-> 决策(选工具+参数)-> 行动(执行工具)
 * -> 再观察(工具结果回传)…… 直到模型认为任务完成并输出最终文本。
 *
 * 在这个项目里,循环由 AI SDK 的 generateText 驱动:检测到模型发起工具调用时,
 * SDK 自动执行对应工具的 execute 函数、把结果拼回上下文、再次请求模型,
 * 如此往复;stopWhen 决定何时强制停止。等价的手写伪代码:
 *
 *   const messages = [system, task];
 *   for (let i = 0; i < MAX_STEPS; i++) {
 *     const res = await llm(messages, tools);
 *     if (res.toolCalls.length === 0) return res.text;   // 模型给出最终回答
 *     for (const call of res.toolCalls) {
 *       const result = await execute(call.tool, call.input);
 *       messages.push({ role: 'tool', result });          // 结果回传,进入下一轮
 *     }
 *   }
 *
 * 理解这段伪代码,比会用任何框架都重要 —— 框架只是把它写得更稳。
 */

/**
 * 系统提示词:模型行为的"宪法"。设计要点(每一条都对应一类真实事故):
 * 1. 固定"先观察后操作"的流程 —— 防止模型凭空臆测页面内容乱点;
 * 2. 建立"ref 会失效"的心智模型 —— 浏览器 agent 最核心的易错点;
 * 3. 明确重试上限与放弃策略 —— 防止同一动作无限重试,烧光 token;
 * 4. 重申安全红线 —— 代码层已强制拦截(硬约束),提示词是软约束,
 *    双保险让模型在"被拦截前"就主动规避,体验与成本都更好。
 */
const SYSTEM_PROMPT = `你是一个谨慎的浏览器操作 Agent。你只能通过工具观察和操作网页,绝不臆测页面内容。

工作流程:
1. 用 browser_navigate 打开任务中给出的第一个网址。
2. 每次操作前先阅读工具返回的 snapshot 字段:每个可交互元素带有 ref 编号(如 e12),点击/输入都通过 ref 进行。
3. 点击或输入后页面往往已变化:以工具返回的最新快照为准,绝不复用记忆里的旧 ref。
4. 工具返回 error 或 blocked 时,按其中的建议行动(通常是重新快照后重试);同一目标最多重试 2 次,仍失败就换路径或放弃并说明原因。
5. 快照中看不到的内容不要编造;需要更多信息时先滚动或重新快照。
6. 不需要反复调用 browser_screenshot:截图是留给人复盘的,对你没有额外信息量。

安全红线(违反会被系统直接拦截):不访问允许列表以外的域名;不向密码框输入任何内容;不尝试登录、提交个人信息或绕过任何站点限制。

任务完成后:用中文输出最终结果。信息摘要类任务用要点列出并注明来源 URL;任务无法完成时,说明原因和已尝试的步骤。`;

/** Agent 运行的步数上限:没有上限的循环 = 失控的 token 账单 */
const MAX_STEPS = 20;

export interface RunResult {
  /** 模型的最终文本回答 */
  answer: string;
  /** 实际执行的步数(1 步 = 1 次模型响应) */
  steps: number;
}

/**
 * 运行浏览器 Agent。
 * @param task    自然语言任务,如"打开 https://quotes.toscrape.com 总结前 5 条引言"
 * @param tools   浏览器工具集(由 createBrowserTools 组装)
 * @param logger  痕迹记录器,记录每步模型行为
 */
export async function runAgent(
  task: string,
  tools: ToolSet,
  logger: TraceLogger,
): Promise<RunResult> {
  /**
   * 为什么用 createOpenAICompatible 而不是具体厂商 SDK:
   * DeepSeek/通义/智谱/Kimi/OpenAI 都实现了同一套 OpenAI Chat API,
   * 只换 baseURL + model 就能切换厂商 —— 项目不与任何一家的 SDK 版本绑死。
   */
  const provider = createOpenAICompatible({
    name: 'browser-agent',
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });

  const result = await generateText({
    model: provider(config.model),
    system: SYSTEM_PROMPT,
    prompt: task,
    tools,
    // 停止条件:步数达到上限即停,即使模型还想继续调工具
    stopWhen: stepCountIs(MAX_STEPS),
    // 每步结束回调:终端实时打印"这一步模型调了什么",运行过程对使用者可见
    onStepEnd: (step) => {
      const calls =
        step.toolCalls
          .map((c) => `${c.toolName}(${JSON.stringify(c.input)})`)
          .join(' ; ') || '(纯文本回复)';
      const line = `第 ${step.stepNumber + 1} 步 → ${calls}`;
      console.log(`  ↳ ${line}`);
      logger.append({
        time: new Date().toISOString(),
        step: step.stepNumber + 1,
        kind: 'info',
        summary: line,
      });
    },
  });

  return { answer: result.text, steps: result.steps.length };
}
